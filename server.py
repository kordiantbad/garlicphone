#!/usr/bin/env python3
"""Garlic Phone — a small, dependency-free multiplayer drawing telephone.

The server intentionally uses only Python's standard library so it can run in a
fresh Python environment. Browsers poll the room state; this makes the game
work on a LAN without a build step or a separate websocket service.
"""
from __future__ import annotations

import json
import os
import secrets
import string
import threading
import time
import uuid
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / "public"
PORT_FILE = ROOT / "port.txt"
DEFAULT_PORT = 8000
HOST = os.environ.get("HOST", "0.0.0.0")

COLORS = ["#7f66ff", "#ff766e", "#f5b83d", "#48c99b", "#55a9ea", "#eb72b5", "#8b6b4e", "#5354a8"]
PROMPTS = [
    "A very suspicious sandwich",
    "A cat that has just discovered taxes",
    "The world's most unnecessary invention",
    "A tiny wizard at a big meeting",
    "A penguin trying to catch a bus",
    "The last slice of pizza on Earth",
    "A dragon working customer support",
    "A robot's first day at the beach",
    "A detective squirrel with a secret",
    "A party where everyone is a potato",
    "A time traveler who forgot why they came",
    "A heroic snail crossing a dangerous kitchen",
]

MODE_INFO = {
    "normal": {"name": "Normal", "emoji": "✏️", "tag": "The classic telephone", "description": "Write, draw, and watch the story evolve."},
    "knockoff": {"name": "Knock-Off", "emoji": "🔁", "tag": "Pass it on", "description": "Each round remixes somebody else's idea."},
    "secret": {"name": "Secret", "emoji": "🤫", "tag": "Keep it hush", "description": "Prompts stay hidden until the grand reveal."},
    "animation": {"name": "Animation", "emoji": "🎞️", "tag": "Bring it to life", "description": "Draw a sequence of frames and flip through the result."},
    "icebreaker": {"name": "Icebreaker", "emoji": "🧊", "tag": "Meet the room", "description": "Easy personal prompts made for new groups."},
    "score": {"name": "Score", "emoji": "🏆", "tag": "Friendly competition", "description": "Rate the funniest transformations and earn stars."},
    "complement": {"name": "Complement", "emoji": "➕", "tag": "Add to the picture", "description": "Build on a drawing instead of starting over."},
    "sandwich": {"name": "Sandwich", "emoji": "🥪", "tag": "Layered chaos", "description": "Alternate words and pictures in extra tasty layers."},
    "background": {"name": "Background", "emoji": "🌄", "tag": "Set the scene", "description": "Draw a setting, then let the group fill it."},
    "solo": {"name": "Solo", "emoji": "🎨", "tag": "Just you", "description": "A private practice gallery with no waiting."},
    "crowd": {"name": "Crowd", "emoji": "👥", "tag": "Big room energy", "description": "A quick, low-pressure party mode for a crowd."},
}

rooms: dict[str, dict] = {}
rooms_lock = threading.RLock()


def now() -> float:
    return time.time()


def read_port() -> int:
    try:
        value = PORT_FILE.read_text(encoding="utf-8").strip()
        port = int(value)
        return port if 1 <= port <= 65535 else DEFAULT_PORT
    except (OSError, ValueError):
        return DEFAULT_PORT


def clean_name(value: str | None) -> str:
    value = " ".join(str(value or "").strip().split())
    return value[:18] or "Anonymous"


def clean_code(value: str | None) -> str:
    return "".join(ch for ch in str(value or "").upper() if ch in string.ascii_uppercase + string.digits)[:8]


def new_code() -> str:
    with rooms_lock:
        while True:
            code = "".join(secrets.choice(string.ascii_uppercase) for _ in range(5))
            if code not in rooms:
                return code


def new_player(name: str, color: str | None = None) -> tuple[str, dict]:
    pid = uuid.uuid4().hex[:12]
    color = color if color in COLORS else secrets.choice(COLORS)
    return pid, {
        "id": pid,
        "name": clean_name(name),
        "color": color,
        "avatar": (clean_name(name)[0] if clean_name(name) else "A").upper(),
        "joined": now(),
        "connected": True,
        "ready": False,
        "score": 0,
    }


def make_room(name: str, color: str | None) -> tuple[str, str]:
    code = new_code()
    pid, player = new_player(name, color)
    room = {
        "code": code,
        "created": now(),
        "host_id": pid,
        "players": {pid: player},
        "settings": {
            "mode": "normal",
            "rounds": 3,
            "timer": 90,
            "language": "English",
            "mature": False,
            "prompts": "standard",
            "room_name": "A fresh phone",
        },
        "phase": "LOBBY",
        "round": 0,
        "submissions": {},
        "chains": {},
        "prompt": secrets.choice(PROMPTS),
        "chat": [{"id": uuid.uuid4().hex, "system": True, "text": f"{player['name']} opened the phone.", "at": now()}],
        "reactions": [],
        "votes": {},
        "version": 1,
        "last_activity": now(),
    }
    with rooms_lock:
        rooms[code] = room
    return code, pid


def find_room(code: str) -> dict | None:
    return rooms.get(clean_code(code))


def active_players(room: dict) -> list[dict]:
    return sorted(room["players"].values(), key=lambda p: p["joined"])


def mode_info(room: dict) -> dict:
    return MODE_INFO.get(room["settings"]["mode"], MODE_INFO["normal"])


def target_for(room: dict, pid: str) -> str:
    people = active_players(room)
    ids = [p["id"] for p in people]
    if pid not in ids:
        return pid
    # The starter owns their first prompt. On the drawing pass, a player gets
    # the previous person's chain. On the following guessing/writing pass the
    # chain changes hands again: use the player's own chain, whose latest
    # drawing was made by somebody else. Alternating these assignments is
    # important — keeping ``previous`` for every round would hand a player's
    # own drawing straight back to them to guess.
    if room["round"] <= 1 or room["round"] % 2 == 1:
        return pid
    return ids[(ids.index(pid) - 1) % len(ids)]


def expected_kind(room: dict) -> str:
    mode = room["settings"]["mode"]
    if room["round"] == 1:
        return "text"
    if mode == "sandwich":
        return "text" if room["round"] % 2 else "drawing"
    if mode == "background":
        return "drawing" if room["round"] <= 2 else "text"
    # Each normal telephone turn alternates writer and artist.
    return "drawing" if room["round"] % 2 == 0 else "text"


def prompt_for(room: dict, pid: str) -> dict:
    target = target_for(room, pid)
    chain = room["chains"].get(target, [])
    reference = chain[-1] if chain else None
    kind = expected_kind(room)
    if room["round"] == 1:
        if room["settings"]["mode"] == "icebreaker":
            text = "What is a tiny thing that always makes you happy?"
        elif room["settings"]["mode"] == "background":
            text = "Describe a place where an adventure could begin."
        else:
            text = room["prompt"]
    elif reference:
        text = reference.get("content", "") if reference.get("kind") == "text" else "Recreate the picture you received."
    else:
        text = room["prompt"]
    return {"kind": kind, "text": text, "reference": reference, "target": target}


def state_for(room: dict, pid: str) -> dict:
    people = active_players(room)
    phase = room["phase"]
    task = None
    if phase in ("WRITING", "DRAWING") and pid in room["players"]:
        task = prompt_for(room, pid)
    public_players = []
    for p in people:
        public_players.append({
            "id": p["id"], "name": p["name"], "avatar": p["avatar"], "color": p["color"],
            "ready": p["ready"], "connected": p["connected"], "is_host": p["id"] == room["host_id"],
            "score": p.get("score", 0),
        })
    # Chains are deliberately private until the gallery. This is what makes
    # Secret mode genuinely secret even when clients are inspecting the API.
    gallery = room["chains"] if phase == "GALLERY" else None
    submitted = len(room["submissions"])
    total = len(people)
    return {
        "code": room["code"],
        "phase": phase,
        "round": room["round"],
        "rounds": room["settings"]["rounds"],
        "mode": room["settings"]["mode"],
        "mode_info": mode_info(room),
        "host_id": room["host_id"],
        "you": pid,
        "is_host": pid == room["host_id"],
        "players": public_players,
        "settings": room["settings"],
        "task": task,
        "submitted": submitted,
        "you_submitted": pid in room["submissions"],
        "total": total,
        "gallery": gallery,
        "votes": room["votes"] if phase == "GALLERY" else {},
        "chat": room["chat"][-60:],
        "reactions": room["reactions"][-24:],
        "prompt": room["prompt"],
        "version": room["version"],
        "server_time": now(),
    }


def touch(room: dict) -> None:
    room["version"] += 1
    room["last_activity"] = now()


def system_chat(room: dict, text: str) -> None:
    room["chat"].append({"id": uuid.uuid4().hex, "system": True, "text": text, "at": now()})
    room["chat"] = room["chat"][-80:]


def reset_rounds(room: dict) -> None:
    room["phase"] = "LOBBY"
    room["round"] = 0
    room["submissions"] = {}
    room["chains"] = {}
    room["votes"] = {}
    room["reactions"] = []
    room["prompt"] = secrets.choice(PROMPTS)
    for player in room["players"].values():
        player["ready"] = False
        player["score"] = 0


def start_game(room: dict) -> None:
    people = active_players(room)
    room["phase"] = "WRITING"
    room["round"] = 1
    room["submissions"] = {}
    room["chains"] = {p["id"]: [] for p in people}
    room["votes"] = {}
    room["reactions"] = []
    room["prompt"] = secrets.choice(PROMPTS)
    for p in people:
        p["ready"] = False
        p["score"] = 0
    system_chat(room, f"The phone is ringing — {mode_info(room)['name']} mode!")


def submit(room: dict, pid: str, content: str, kind: str) -> tuple[bool, str]:
    if room["phase"] not in ("WRITING", "DRAWING"):
        return False, "This round is not accepting submissions."
    if pid in room["submissions"]:
        return False, "You already submitted this turn."
    task = prompt_for(room, pid)
    expected = task["kind"]
    if kind != expected:
        return False, "That is not the current turn type."
    content = str(content or "")
    if kind == "text":
        content = " ".join(content.strip().split())[:280]
        if not content:
            return False, "Add a little something first."
    else:
        if not content.startswith("data:image/"):
            return False, "Please submit a drawing."
        if len(content) > 3_500_000:
            return False, "That drawing is too large. Try a smaller canvas."
    target = task["target"]
    room["chains"].setdefault(target, []).append({
        "kind": kind,
        "content": content,
        "author": pid,
        "author_name": room["players"][pid]["name"],
        "round": room["round"],
        "at": now(),
    })
    room["submissions"][pid] = True
    people = active_players(room)
    if len(room["submissions"]) >= len(people):
        if room["round"] >= room["settings"]["rounds"]:
            room["phase"] = "GALLERY"
            system_chat(room, "The reveal is ready! Compare the transformations.")
        else:
            room["round"] += 1
            room["phase"] = "DRAWING" if expected == "text" else "WRITING"
            room["submissions"] = {}
            label = "draw" if room["phase"] == "DRAWING" else "write"
            system_chat(room, f"Pass complete. Time to {label} the next link.")
    touch(room)
    return True, "Submitted!"


def handle_action(room: dict, pid: str, action: str, payload: dict) -> tuple[bool, str]:
    if pid not in room["players"]:
        return False, "You are not in this room."
    player = room["players"][pid]
    if action == "heartbeat":
        player["connected"] = True
        player["last_seen"] = now()
        return True, ""
    if action == "profile":
        if room["phase"] != "LOBBY":
            return False, "Profiles are locked once a game starts."
        player["name"] = clean_name(payload.get("name"))
        player["avatar"] = player["name"][0].upper()
        if payload.get("color") in COLORS:
            player["color"] = payload["color"]
        touch(room)
        return True, "Profile updated."
    if action == "set_settings":
        if pid != room["host_id"] or room["phase"] != "LOBBY":
            return False, "Only the host can change lobby settings."
        key = str(payload.get("key", ""))
        value = payload.get("value")
        if key == "mode" and value in MODE_INFO:
            room["settings"][key] = value
        elif key == "rounds":
            room["settings"][key] = max(1, min(8, int(value)))
        elif key == "timer":
            room["settings"][key] = max(15, min(300, int(value)))
        elif key in ("mature",) and isinstance(value, bool):
            room["settings"][key] = value
        elif key == "room_name":
            room["settings"][key] = clean_name(value)[:30]
        else:
            return False, "Unknown setting."
        touch(room)
        return True, "Settings updated."
    if action == "ready":
        player["ready"] = not player["ready"]
        touch(room)
        return True, ""
    if action == "start":
        if pid != room["host_id"]:
            return False, "Only the host can start the game."
        if room["phase"] != "LOBBY":
            return False, "A game is already running."
        start_game(room)
        touch(room)
        return True, "Game started!"
    if action == "submit":
        return submit(room, pid, payload.get("content", ""), payload.get("kind", ""))
    if action == "vote":
        if room["phase"] != "GALLERY":
            return False, "Voting opens at the reveal."
        target = str(payload.get("target", ""))
        value = max(1, min(5, int(payload.get("value", 5))))
        if target not in room["chains"]:
            return False, "That chain does not exist."
        room["votes"].setdefault(target, {})[pid] = value
        # Score mode is intentionally light: stars reward the author of the
        # voted chain, while everyone still sees the full gallery.
        if room["settings"]["mode"] == "score":
            author = room["chains"][target][0].get("author") if room["chains"][target] else None
            if author in room["players"]:
                room["players"][author]["score"] = sum(room["votes"].get(target, {}).values())
        touch(room)
        return True, "Vote saved."
    if action == "chat":
        text = " ".join(str(payload.get("text", "")).strip().split())[:240]
        if not text:
            return False, ""
        room["chat"].append({"id": uuid.uuid4().hex, "player": pid, "name": player["name"], "color": player["color"], "text": text, "at": now()})
        room["chat"] = room["chat"][-80:]
        touch(room)
        return True, ""
    if action == "react":
        emoji = str(payload.get("emoji", ""))
        if emoji not in ("😂", "🔥", "👏", "😮", "💀", "❤️", "✨"):
            return False, ""
        room["reactions"].append({"id": uuid.uuid4().hex, "emoji": emoji, "name": player["name"], "player": pid, "at": now()})
        room["reactions"] = room["reactions"][-24:]
        touch(room)
        return True, ""
    if action == "reset":
        if pid != room["host_id"]:
            return False, "Only the host can restart."
        reset_rounds(room)
        system_chat(room, f"{player['name']} reset the phone.")
        touch(room)
        return True, "Back in the lobby."
    if action == "kick":
        if pid != room["host_id"] or room["phase"] != "LOBBY":
            return False, "Only the host can remove lobby players."
        target = str(payload.get("target", ""))
        if target == room["host_id"] or target not in room["players"]:
            return False, "That player cannot be removed."
        name = room["players"][target]["name"]
        del room["players"][target]
        system_chat(room, f"{name} left the room.")
        touch(room)
        return True, "Player removed."
    return False, "Unknown action."


class Handler(BaseHTTPRequestHandler):
    server_version = "GarlicPhone/1.0"

    def log_message(self, fmt: str, *args) -> None:
        # Keep the terminal useful: only API/server errors are printed below.
        if self.path.startswith("/api/") and self.command not in ("GET",):
            super().log_message(fmt, *args)

    def _headers(self, status=HTTPStatus.OK, content_type="application/json; charset=utf-8", length=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        if length is not None:
            self.send_header("Content-Length", str(length))
        self.end_headers()

    def _json(self, status, data):
        raw = json.dumps(data, separators=(",", ":")).encode("utf-8")
        self._headers(status, length=len(raw))
        self.wfile.write(raw)

    def _body(self) -> dict:
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if size > 8_000_000:
                return {}
            raw = self.rfile.read(size)
            return json.loads(raw.decode("utf-8")) if raw else {}
        except (ValueError, json.JSONDecodeError, UnicodeDecodeError):
            return {}

    def do_OPTIONS(self):
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        if path == "/api/health":
            self._json(HTTPStatus.OK, {"ok": True, "game": "Garlic Phone", "rooms": len(rooms)})
            return
        if path == "/api/config":
            self._json(HTTPStatus.OK, {"modes": MODE_INFO, "colors": COLORS, "prompts": PROMPTS})
            return
        if path.startswith("/api/rooms/"):
            code = clean_code(path.split("/")[-1])
            room = find_room(code)
            query = parse_qs(parsed.query)
            pid = query.get("player", [""])[0]
            if not room:
                self._json(HTTPStatus.NOT_FOUND, {"error": "Room not found"})
            else:
                with rooms_lock:
                    self._json(HTTPStatus.OK, state_for(room, pid))
            return
        self.serve_file(path)

    def do_POST(self):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        body = self._body()
        if path == "/api/rooms":
            code, pid = make_room(body.get("name"), body.get("color"))
            self._json(HTTPStatus.CREATED, {"code": code, "player_id": pid})
            return
        if path == "/api/rooms/join":
            code = clean_code(body.get("code"))
            room = find_room(code)
            if not room:
                self._json(HTTPStatus.NOT_FOUND, {"error": "We couldn't find that room."})
                return
            if room["phase"] != "LOBBY":
                self._json(HTTPStatus.CONFLICT, {"error": "This phone is already ringing. Join the next game."})
                return
            if len(room["players"]) >= 64:
                self._json(HTTPStatus.CONFLICT, {"error": "This room is full."})
                return
            with rooms_lock:
                pid, player = new_player(body.get("name"), body.get("color"))
                room["players"][pid] = player
                system_chat(room, f"{player['name']} picked up the phone.")
                touch(room)
            self._json(HTTPStatus.CREATED, {"code": code, "player_id": pid})
            return
        if path.startswith("/api/rooms/"):
            parts = path.strip("/").split("/")
            code = clean_code(parts[2]) if len(parts) >= 3 else ""
            room = find_room(code)
            if not room:
                self._json(HTTPStatus.NOT_FOUND, {"error": "Room not found"})
                return
            pid = str(body.pop("player_id", ""))
            action = str(body.pop("action", ""))
            with rooms_lock:
                ok, message = handle_action(room, pid, action, body)
                status = HTTPStatus.OK if ok else HTTPStatus.BAD_REQUEST
                self._json(status, {"ok": ok, "message": message, "state": state_for(room, pid)})
            return
        self._json(HTTPStatus.NOT_FOUND, {"error": "Not found"})

    def serve_file(self, path: str):
        if path in ("", "/"):
            path = "/index.html"
        relative = path.lstrip("/")
        candidate = (PUBLIC / relative).resolve()
        if PUBLIC not in candidate.parents and candidate != PUBLIC:
            self._json(HTTPStatus.NOT_FOUND, {"error": "Not found"})
            return
        if not candidate.is_file():
            self._json(HTTPStatus.NOT_FOUND, {"error": "Not found"})
            return
        mime = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml"}.get(candidate.suffix, "application/octet-stream")
        data = candidate.read_bytes()
        self._headers(HTTPStatus.OK, mime, len(data))
        self.wfile.write(data)


def cleanup_rooms() -> None:
    # Kept as a separate function so a deployment can call it from a scheduler.
    cutoff = now() - 60 * 60 * 6
    with rooms_lock:
        for code in list(rooms):
            if rooms[code]["last_activity"] < cutoff:
                del rooms[code]


def main() -> None:
    port = read_port()
    server = ThreadingHTTPServer((HOST, port), Handler)
    print(f"Garlic Phone listening on http://{HOST}:{port}")
    print("Open the address from another device on your LAN to play together.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nGoodbye!")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
