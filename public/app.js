/* Garlic Phone client. It is deliberately vanilla JS so the game can be hosted by
   the tiny Python server with no package install or build step. */
(() => {
  "use strict";

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const app = {
    code: "",
    playerId: "",
    state: null,
    config: { modes: {}, colors: [] },
    poller: null,
    renderVersion: -1,
    phaseKey: "",
    phaseStarted: Date.now(),
    timedOutKey: "",
    timer: null,
    galleryFilter: "all",
    drawing: { ready: false, canvas: null, ctx: null, color: "#24233c", size: 8, tool: "pen", down: false, history: [], future: [] },
  };

  const escapeHTML = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#39;", '"':"&quot;" }[char]));
  const initials = (name) => (String(name || "A").trim()[0] || "A").toUpperCase();
  const mode = (key) => app.config.modes[key] || { name: key, emoji: "✦", tag: "", description: "" };

  async function request(url, options = {}) {
    const response = await fetch(url, { credentials: "same-origin", ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
    let data = {};
    try { data = await response.json(); } catch (_) { /* the error below is enough */ }
    if (!response.ok) throw new Error(data.error || data.message || `Request failed (${response.status})`);
    return data;
  }

  async function loadConfig() {
    try {
      app.config = await request("/api/config");
    } catch (_) {
      app.config = { modes: { normal: { name: "Normal", emoji: "✏️", tag: "The classic telephone", description: "Write, draw, and watch the story evolve." } }, colors: ["#7f66ff", "#ff766e", "#f5b83d", "#48c99b"] };
    }
  }

  function showScreen(id) {
    $$(".screen").forEach((screen) => {
      const on = screen.id === id;
      screen.hidden = !on;
      screen.classList.toggle("active", on);
    });
  }

  function toast(message, type = "") {
    if (!message) return;
    const item = document.createElement("div");
    item.className = `toast ${type}`;
    item.textContent = message;
    $("#toast-stack").appendChild(item);
    setTimeout(() => item.remove(), 3300);
  }

  function openModal(markup) {
    const layer = $("#modal-layer");
    layer.innerHTML = markup;
    layer.hidden = false;
    requestAnimationFrame(() => $(".modal input", layer)?.focus());
  }
  function closeModal() {
    const layer = $("#modal-layer");
    layer.hidden = true;
    layer.innerHTML = "";
  }
  function colorChoices(selected = "#7f66ff") {
    return (app.config.colors || []).map((color, i) => `<button type="button" class="color-choice ${color === selected || (!selected && i === 0) ? "active" : ""}" style="--c:${color}" data-color="${color}" aria-label="Choose color ${i + 1}"></button>`).join("");
  }

  function createModal() {
    openModal(`<div class="modal" role="dialog" aria-modal="true" aria-labelledby="create-title">
      <button class="modal-close" data-action="close-modal" aria-label="Close">×</button>
      <div class="eyebrow"><span>✦</span> start a new phone</div><h2 id="create-title">Who's picking up?</h2>
      <p>Choose a name and a color. You can change your mind in the lobby.</p>
      <form id="create-form"><label class="field"><span>Your display name</span><input id="create-name" name="name" maxlength="18" placeholder="e.g. Pickle Rick" autocomplete="nickname" required></label>
      <label class="field"><span>Your color</span><div class="color-picker">${colorChoices()}</div><input type="hidden" name="color" value="#7f66ff"></label>
      <button class="button button-primary" type="submit">Create the room <span>→</span></button></form>
      <p class="modal-note">You'll be the host. Send the room code to your friends.</p>
    </div>`);
  }

  function joinModal(prefill = "") {
    openModal(`<div class="modal" role="dialog" aria-modal="true" aria-labelledby="join-title">
      <button class="modal-close" data-action="close-modal" aria-label="Close">×</button>
      <div class="eyebrow"><span>✦</span> join the fun</div><h2 id="join-title">Pick up the phone.</h2>
      <p>Enter the five-letter code your host sent you. Then choose how the room should know you.</p>
      <form id="join-form"><label class="field"><span>Room code</span><input id="join-code" class="code-input" name="code" maxlength="8" value="${escapeHTML(prefill)}" placeholder="ABCDE" autocomplete="off" required></label>
      <label class="field"><span>Your display name</span><input id="join-name" name="name" maxlength="18" placeholder="e.g. Doodlebug" autocomplete="nickname" required></label>
      <label class="field"><span>Your color</span><div class="color-picker">${colorChoices("#ff766e")}</div><input type="hidden" name="color" value="#ff766e"></label>
      <button class="button button-primary" type="submit">Join the room <span>→</span></button></form>
      <p class="modal-note">No account needed. We don't keep your doodles after the room closes.</p>
    </div>`);
    const code = $("#join-code");
    if (code) { code.focus(); code.addEventListener("input", () => { code.value = code.value.toUpperCase().replace(/[^A-Z0-9]/g, ""); }); }
  }

  function howModal() {
    openModal(`<div class="modal" role="dialog" aria-modal="true" aria-labelledby="how-title">
      <button class="modal-close" data-action="close-modal" aria-label="Close">×</button>
      <div class="eyebrow"><span>✦</span> tiny rulebook</div><h2 id="how-title">How to play</h2>
      <p>Garlic Phone is a telephone game for your imagination. Every pass changes the story a little.</p>
      <div class="how-grid"><div class="how-card"><b>01 · Write</b><p>Start with a silly prompt. Say the first thing that comes to mind.</p></div><div class="how-card"><b>02 · Draw</b><p>Interpret another player's words. Excellent art is very optional.</p></div><div class="how-card"><b>03 · Pass</b><p>Each round gets a new link in the chain. Don't peek at the other phones.</p></div><div class="how-card"><b>04 · Reveal</b><p>Compare the original idea with its final form and crown a favorite.</p></div></div>
      <button class="button button-primary" data-action="close-modal" style="margin-top:20px">Got it, let's play</button>
    </div>`);
  }

  function saveSession() {
    if (app.code && app.playerId) localStorage.setItem("garlicphone-session", JSON.stringify({ code: app.code, playerId: app.playerId }));
  }
  function clearSession() { localStorage.removeItem("garlicphone-session"); }

  async function enterRoom(code, playerId) {
    app.code = code;
    app.playerId = playerId;
    app.renderVersion = -1;
    saveSession();
    history.replaceState({}, "", `?room=${encodeURIComponent(code)}`);
    closeModal();
    showScreen("lobby-screen");
    await poll(true);
    clearInterval(app.poller);
    app.poller = setInterval(() => poll(false), 900);
  }

  async function poll(showErrors = false) {
    if (!app.code || !app.playerId) return;
    try {
      const next = await request(`/api/rooms/${encodeURIComponent(app.code)}?player=${encodeURIComponent(app.playerId)}`);
      app.state = next;
      render(next);
    } catch (error) {
      if (showErrors || !app.state) toast(error.message, "error");
      if (/not found/i.test(error.message)) leaveToHome(false);
    }
  }

  async function action(name, payload = {}, quiet = false) {
    if (!app.code || !app.playerId) return null;
    try {
      const result = await request(`/api/rooms/${encodeURIComponent(app.code)}`, { method: "POST", body: JSON.stringify({ player_id: app.playerId, action: name, ...payload }) });
      if (result.state) { app.state = result.state; render(result.state); }
      if (result.message && !quiet) toast(result.message, "success");
      return result;
    } catch (error) {
      if (!quiet) toast(error.message, "error");
      return null;
    }
  }

  function lobbyModes() {
    const target = $("#mode-grid");
    if (!target) return;
    const selected = app.state?.settings?.mode || "normal";
    target.innerHTML = Object.entries(app.config.modes).map(([key, info]) => `<button class="mode-card ${key === selected ? "selected" : ""}" data-action="mode" data-mode="${key}" title="${escapeHTML(info.description)}"><span class="mode-emoji">${info.emoji}</span><strong>${escapeHTML(info.name)}</strong><small>${escapeHTML(info.tag)}</small>${key === selected ? '<i class="mode-check">✓</i>' : ""}</button>`).join("");
    const info = mode(selected);
    const note = $("#selected-mode-note");
    if (note) note.textContent = `${info.name}: ${info.description}`;
  }

  function renderPlayers(state) {
    const grid = $("#player-grid");
    if (!grid) return;
    grid.innerHTML = state.players.map((player) => `<div class="player-card" title="${escapeHTML(player.name)}"><div class="player-avatar" style="background:${player.color}">${escapeHTML(player.avatar)}</div>${player.is_host ? '<span class="host-crown">♛</span>' : ""}<b>${escapeHTML(player.name)}${player.id === state.you ? " (you)" : ""}</b><small>${player.ready ? "ready ✓" : player.is_host ? "host" : "in the room"}</small>${state.is_host && !player.is_host ? `<button class="remove-player" data-action="kick" data-target="${player.id}" title="Remove player">×</button>` : ""}${player.id === state.you && !state.is_host ? `<button class="link-button ready-toggle" data-action="ready">${player.ready ? "Unready" : "Ready up"}</button>` : ""}</div>`).join("");
    $("#player-count").textContent = `${state.players.length} / 64`;
    $("#online-count").textContent = state.players.length;
    $("#ready-count").textContent = state.players.filter((p) => p.ready).length;
    const mine = state.players.find((p) => p.id === state.you);
    if (mine) { $("#my-avatar").textContent = mine.avatar; $("#my-avatar").style.background = mine.color; }
  }

  function renderChat(state) {
    const target = $("#chat-messages");
    if (!target) return;
    const wasAtBottom = target.scrollTop + target.clientHeight >= target.scrollHeight - 20;
    target.innerHTML = state.chat.map((message) => message.system
      ? `<div class="chat-msg system">${escapeHTML(message.text)}</div>`
      : `<div class="chat-msg"><span class="chat-avatar" style="background:${message.color || "#7f66ff"}">${escapeHTML(initials(message.name))}</span><p><b>${escapeHTML(message.name)}</b>${escapeHTML(message.text)}</p></div>`).join("");
    if (wasAtBottom) target.scrollTop = target.scrollHeight;
  }

  function renderLobby(state) {
    $("#top-room-code").textContent = state.code;
    $("#room-title").textContent = state.settings.room_name || "A fresh phone";
    renderPlayers(state);
    renderChat(state);
    lobbyModes();
    const rounds = $("#rounds-setting"); const timer = $("#timer-setting"); const mature = $("#mature-setting");
    if (rounds) rounds.value = String(state.settings.rounds);
    if (timer) timer.value = String(state.settings.timer);
    if (mature) mature.checked = !!state.settings.mature;
    const start = $("#start-game");
    if (start) { start.disabled = !state.is_host; start.title = state.is_host ? "Start the game" : "The host starts the game"; start.innerHTML = state.is_host ? 'Start the phone <span>→</span>' : 'Waiting for host <span>…</span>'; }
    $("#top-room-code").setAttribute("title", `Room ${state.code}`);
  }

  function setReference(container, task, fallbackText) {
    if (!container) return;
    const ref = task?.reference;
    if (ref?.kind === "drawing" && String(ref.content).startsWith("data:image/")) {
      container.innerHTML = `<span class="prompt-label">DRAW THIS IDEA</span><div class="reference-content"><img src="${ref.content}" alt="A drawing from the phone"></div>`;
    } else {
      container.innerHTML = `<span class="prompt-label">${task?.kind === "drawing" ? "DRAW THIS IDEA" : "YOUR PROMPT"}</span><div class="reference-content">${escapeHTML((ref?.content || task?.text || fallbackText || ""))}</div>`;
    }
  }

  function initCanvas(clear = true) {
    const canvas = $("#draw-canvas");
    if (!canvas) return;
    app.drawing.canvas = canvas;
    app.drawing.ctx = canvas.getContext("2d", { willReadFrequently: true });
    app.drawing.ready = true;
    app.drawing.history = [];
    app.drawing.future = [];
    if (clear) {
      const ctx = app.drawing.ctx;
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      rememberCanvas();
      $(".canvas-wrap")?.classList.remove("has-ink");
    }
    canvas.onpointerdown = startStroke;
    canvas.onpointermove = moveStroke;
    canvas.onpointerup = endStroke;
    canvas.onpointerleave = endStroke;
    updateToolUI();
  }
  function rememberCanvas() {
    const { canvas } = app.drawing;
    if (!canvas) return;
    app.drawing.history.push(canvas.toDataURL("image/png"));
    if (app.drawing.history.length > 24) app.drawing.history.shift();
    app.drawing.future = [];
  }
  function pointOnCanvas(event) {
    const rect = app.drawing.canvas.getBoundingClientRect();
    return { x: (event.clientX - rect.left) * app.drawing.canvas.width / rect.width, y: (event.clientY - rect.top) * app.drawing.canvas.height / rect.height };
  }
  function startStroke(event) {
    if (!app.drawing.canvas) return;
    app.drawing.down = true; app.drawing.canvas.setPointerCapture?.(event.pointerId);
    const point = pointOnCanvas(event); const ctx = app.drawing.ctx;
    ctx.beginPath(); ctx.moveTo(point.x, point.y); ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.lineWidth = app.drawing.size;
    ctx.strokeStyle = app.drawing.color; ctx.globalCompositeOperation = app.drawing.tool === "eraser" ? "destination-out" : "source-over";
    ctx.lineTo(point.x + .1, point.y + .1); ctx.stroke();
    $(".canvas-wrap")?.classList.add("has-ink");
  }
  function moveStroke(event) {
    if (!app.drawing.down) return;
    const point = pointOnCanvas(event); const ctx = app.drawing.ctx;
    ctx.lineTo(point.x, point.y); ctx.stroke();
  }
  function endStroke() { if (app.drawing.down) { app.drawing.down = false; rememberCanvas(); } }
  function updateToolUI() {
    $$(".tool-button").forEach((button) => button.classList.toggle("active", button.dataset.tool === app.drawing.tool));
    $$(".color-swatch").forEach((button) => button.classList.toggle("active", button.dataset.color === app.drawing.color));
  }
  function restoreCanvas(data) {
    const image = new Image();
    image.onload = () => { app.drawing.ctx.clearRect(0, 0, app.drawing.canvas.width, app.drawing.canvas.height); app.drawing.ctx.drawImage(image, 0, 0); };
    image.src = data;
  }
  function undo() {
    if (app.drawing.history.length <= 1) return;
    const current = app.drawing.history.pop(); app.drawing.future.push(current);
    restoreCanvas(app.drawing.history[app.drawing.history.length - 1]);
  }
  function redo() {
    if (!app.drawing.future.length) return;
    const data = app.drawing.future.pop(); app.drawing.history.push(data); restoreCanvas(data);
  }
  function clearCanvas() { if (!app.drawing.ctx) return; app.drawing.ctx.clearRect(0, 0, app.drawing.canvas.width, app.drawing.canvas.height); app.drawing.ctx.fillStyle = "#fff"; app.drawing.ctx.fillRect(0, 0, app.drawing.canvas.width, app.drawing.canvas.height); rememberCanvas(); $(".canvas-wrap")?.classList.remove("has-ink"); }

  function renderGame(state) {
    $("#top-room-code").textContent = state.code;
    $("#game-mode-name").textContent = mode(state.mode).name.toUpperCase();
    $("#game-round-label").textContent = state.phase === "GALLERY" ? "FINAL REVEAL" : `ROUND ${state.round} OF ${state.rounds}`;
    const mine = state.players.find((player) => player.id === state.you);
    if (mine) { $("#game-avatar").textContent = mine.avatar; $("#game-avatar").style.background = mine.color; }
    const key = `${state.phase}:${state.round}`;
    if (key !== app.phaseKey) { app.phaseKey = key; app.phaseStarted = Date.now(); app.timedOutKey = ""; app.drawing.ready = false; }
    const writing = $("#writing-view"), drawing = $("#drawing-view"), waiting = $("#waiting-view"), gallery = $("#gallery-view");
    [writing, drawing, waiting, gallery].forEach((view) => { if (view) view.hidden = true; });
    if (state.phase === "GALLERY") {
      gallery.hidden = false; renderGallery(state);
    } else if (state.you_submitted) {
      waiting.hidden = false;
      $("#waiting-count").textContent = `${Math.max(0, state.total - state.submitted)} ${state.total - state.submitted === 1 ? "person" : "people"} still drawing`;
    } else if (state.phase === "WRITING") {
      writing.hidden = false; renderWritingTask(state);
    } else {
      drawing.hidden = false; renderDrawingTask(state);
      if (!app.drawing.ready) initCanvas(true);
    }
    const progress = state.phase === "GALLERY" ? 100 : state.total ? (state.submitted / state.total) * 100 : 0;
    $("#progress-bar").style.width = `${progress}%`;
    $("#submission-label").textContent = state.phase === "GALLERY" ? "all stories revealed" : `${state.submitted} / ${state.total} done`;
    $("#phase-label").textContent = state.phase === "GALLERY" ? "THE REVEAL" : state.you_submitted ? "IN THE PHONE" : state.phase === "DRAWING" ? "YOUR TURN TO DRAW" : "YOUR TURN TO WRITE";
  }

  function renderWritingTask(state) {
    const task = state.task || {};
    const isFirst = state.round === 1;
    $("#writing-title").textContent = isFirst ? "Put your spin on it." : "What does this picture say?";
    $("#writing-subtitle").textContent = mode(state.mode).description || "No pressure. The first thought is usually the funniest.";
    $("#writing-prompt").textContent = task.text || state.prompt;
    const card = $("#writing-view .prompt-card");
    if (task.reference?.kind === "drawing" && String(task.reference.content).startsWith("data:image/")) {
      card.innerHTML = `<span class="prompt-label">WHAT DO YOU SEE?</span><img src="${task.reference.content}" alt="A drawing to interpret" style="max-width:180px;max-height:90px;margin-top:8px;border-radius:8px"><span class="prompt-squiggle">〰〰</span>`;
    } else {
      card.innerHTML = `<span class="prompt-label">${isFirst ? "YOUR PROMPT" : "THE LAST PLAYER DREW"}</span><div class="prompt-text" id="writing-prompt">${escapeHTML(task.text || state.prompt)}</div><span class="prompt-squiggle">〰〰</span>`;
    }
  }

  function renderDrawingTask(state) {
    const task = state.task || {};
    $("#drawing-title").textContent = state.mode === "animation" ? "Draw a frame." : "Draw what you see.";
    $("#drawing-subtitle").textContent = mode(state.mode).description || "Stick figures are not only allowed, they are encouraged.";
    setReference($("#reference-card"), task, state.prompt);
  }

  function renderGallery(state) {
    const allChains = Object.entries(state.gallery || {});
    $("#gallery-count").textContent = allChains.length;
    const target = $("#gallery-grid");
    const filtered = allChains.filter(([, chain]) => app.galleryFilter === "all" || chain.some((item) => item.kind === app.galleryFilter));
    target.innerHTML = filtered.length ? filtered.map(([chainId, chain], index) => {
      const score = Object.values((state.votes || {})[chainId] || {}).reduce((a, b) => a + Number(b), 0);
      const links = chain.map((item, i) => `<div class="chain-link ${item.kind === "drawing" ? "draw" : "text"}"><span class="link-icon">${item.kind === "drawing" ? "✎" : "Aa"}</span><div class="chain-link-body"><small>${item.kind === "drawing" ? "DRAWING" : "WORDS"} · ${escapeHTML(item.author_name || "player")}</small>${item.kind === "drawing" ? `<img src="${item.content}" alt="A drawing in the telephone chain">` : `<p>${escapeHTML(item.content)}</p>`}</div></div>${i < chain.length - 1 ? '<div class="chain-arrow">↓</div>' : ""}`).join("");
      return `<article class="chain-card" data-chain="${chainId}"><div class="chain-head"><strong>telephone chain</strong><span class="chain-number">${index + 1}</span></div><div class="chain-content">${links || '<p style="color:#aaa;font-size:12px">This chain is shy.</p>'}</div><div class="chain-vote"><span>${score ? `${score} stars from the room` : "Rate this transformation"}</span><div class="stars">${[1,2,3,4,5].map((star) => `<button data-action="vote" data-target="${chainId}" data-value="${star}" class="${((state.votes || {})[chainId] || {})[state.you] === star ? "selected" : ""}" aria-label="Give ${star} stars">★</button>`).join("")}</div></div></article>`;
    }).join("") : `<div class="empty-gallery"><h3>Nothing in this filter yet.</h3><p>Try showing all stories.</p></div>`;
  }

  function render(state) {
    if (!state) return;
    if (state.phase === "LOBBY") { showScreen("lobby-screen"); renderLobby(state); }
    else { showScreen("game-screen"); renderGame(state); }
    if (state.version !== app.renderVersion) {
      renderChat(state);
      spawnReactions(state.reactions || []);
      app.renderVersion = state.version;
    }
  }

  function spawnReactions(reactions) {
    const target = $("#floating-reactions");
    if (!target || !reactions.length) return;
    const last = reactions.slice(-3);
    last.forEach((reaction, i) => {
      const item = document.createElement("span"); item.textContent = reaction.emoji; item.style.left = `${35 + i * 10 + Math.random() * 12}%`; item.style.bottom = `${12 + Math.random() * 8}%`; target.appendChild(item); setTimeout(() => item.remove(), 1800);
    });
    const burst = $("#reaction-burst");
    if (burst) burst.innerHTML = reactions.slice(-7).map((r) => `<span>${r.emoji}</span>`).join("");
  }

  function updateTimer() {
    if (!app.state || app.state.phase === "LOBBY" || app.state.phase === "GALLERY") return;
    const total = Number(app.state.settings?.timer || 90);
    const remaining = Math.max(0, total - Math.floor((Date.now() - app.phaseStarted) / 1000));
    const minutes = String(Math.floor(remaining / 60)).padStart(2, "0"); const seconds = String(remaining % 60).padStart(2, "0");
    const value = $("#timer-value"); const pill = $("#timer-pill");
    if (value) value.textContent = `${minutes}:${seconds}`;
    if (pill) pill.classList.toggle("warning", remaining <= 10);
    // A timer should never strand a room because one person wandered away.
    // The client that reaches zero submits a harmless placeholder for its own turn;
    // the normal server validation and turn transition still apply.
    const timeoutKey = `${app.state.phase}:${app.state.round}`;
    if (remaining === 0 && !app.state.you_submitted && app.timedOutKey !== timeoutKey) {
      app.timedOutKey = timeoutKey;
      if (app.state.phase === "WRITING") {
        const input = $("#writing-input");
        action("submit", { kind: "text", content: input?.value.trim() || "A mysterious little thing" }, true);
      } else if (app.state.phase === "DRAWING" && app.drawing.canvas) {
        action("submit", { kind: "drawing", content: app.drawing.canvas.toDataURL("image/jpeg", .78) }, true);
      }
    }
  }

  function leaveToHome(clear = true) {
    clearInterval(app.poller); app.poller = null; app.code = ""; app.playerId = ""; app.state = null; app.phaseKey = ""; if (clear) clearSession(); history.replaceState({}, "", location.pathname); closeModal(); showScreen("landing-screen");
  }

  async function copyRoom() {
    if (!app.code) return;
    const invite = `${location.origin}${location.pathname}?room=${app.code}`;
    try { await navigator.clipboard.writeText(`Join my Garlic Phone game: ${invite}`); toast("Invite link copied!", "success"); }
    catch (_) { toast(`Room code: ${app.code}`, "success"); }
  }

  function showChatModal() {
    if (!app.state) return;
    const messages = app.state.chat.map((message) => message.system ? `<div class="chat-msg system">${escapeHTML(message.text)}</div>` : `<div class="chat-msg"><span class="chat-avatar" style="background:${message.color || "#7f66ff"}">${escapeHTML(initials(message.name))}</span><p><b>${escapeHTML(message.name)}</b>${escapeHTML(message.text)}</p></div>`).join("");
    openModal(`<div class="modal" role="dialog" aria-modal="true" aria-labelledby="chat-title"><button class="modal-close" data-action="close-modal">×</button><div class="eyebrow"><span>✦</span> room chat</div><h2 id="chat-title">Keep the vibes going.</h2><div class="chat-messages" style="height:260px;border:1px solid #eee7dd;border-radius:11px;margin:17px 0">${messages}</div><form class="chat-form" id="game-chat-form" style="margin:0;border:1px solid #e8e1d7;border-radius:10px;padding:4px 5px 4px 9px"><input id="game-chat-input" autocomplete="off" placeholder="Say something nice..." maxlength="240"><button>↑</button></form></div>`);
  }

  document.addEventListener("click", async (event) => {
    const target = event.target.closest("[data-action]");
    if (!target) return;
    const act = target.dataset.action;
    if (act === "open-create") createModal();
    else if (act === "open-join") joinModal(new URLSearchParams(location.search).get("room") || "");
    else if (act === "how" || act === "open-how") howModal();
    else if (act === "close-modal") closeModal();
    else if (act === "home") { event.preventDefault(); leaveToHome(true); }
    else if (act === "copy-room") copyRoom();
    else if (act === "toggle-settings") toast("House rules are ready in the panel.");
    else if (act === "leave") leaveToHome(true);
    else if (act === "mode") { if (app.state?.is_host) action("set_settings", { key: "mode", value: target.dataset.mode }); else toast("Only the host can choose a mode."); }
    else if (act === "ready") action("ready", {}, true);
    else if (act === "start") action("start");
    else if (act === "kick") action("kick", { target: target.dataset.target });
    else if (act === "react") { action("react", { emoji: target.dataset.emoji }, true); }
    else if (act === "submit-writing") {
      const input = $("#writing-input"); if (!input?.value.trim()) { toast("Write a little something first!", "error"); input?.focus(); } else { target.disabled = true; await action("submit", { kind: "text", content: input.value }); target.disabled = false; }
    }
    else if (act === "submit-drawing") {
      if (!app.drawing.canvas) return;
      target.disabled = true; await action("submit", { kind: "drawing", content: app.drawing.canvas.toDataURL("image/jpeg", .82) }); target.disabled = false;
    }
    else if (act === "undo") undo();
    else if (act === "redo") redo();
    else if (act === "clear-canvas") clearCanvas();
    else if (act === "play-again") { if (app.state?.is_host) action("reset"); else toast("The host can start the next phone."); }
    else if (act === "toggle-chat") showChatModal();
    else if (act === "vote") action("vote", { target: target.dataset.target, value: Number(target.dataset.value) }, true);
  });

  document.addEventListener("click", (event) => {
    const swatch = event.target.closest("[data-color]");
    if (swatch && swatch.classList.contains("color-choice")) {
      $$(".color-choice").forEach((button) => button.classList.remove("active")); swatch.classList.add("active");
      const hidden = swatch.closest("form")?.querySelector("input[name=color]"); if (hidden) hidden.value = swatch.dataset.color;
    }
    const drawingColor = event.target.closest(".color-swatch[data-color]");
    if (drawingColor) { app.drawing.color = drawingColor.dataset.color; app.drawing.tool = "pen"; updateToolUI(); }
    const tool = event.target.closest(".tool-button[data-tool]");
    if (tool) { app.drawing.tool = tool.dataset.tool; updateToolUI(); }
    const filter = event.target.closest("[data-gallery-filter]");
    if (filter) { app.galleryFilter = filter.dataset.galleryFilter; $$("[data-gallery-filter]").forEach((b) => b.classList.toggle("active", b === filter)); if (app.state) renderGallery(app.state); }
    const prompt = event.target.closest("[data-prompt]");
    if (prompt) { const input = $("#writing-input"); if (input) { input.value = `${input.value}${input.value ? " " : ""}${prompt.dataset.prompt}.`; input.dispatchEvent(new Event("input")); input.focus(); } }
  });

  document.addEventListener("input", (event) => {
    if (event.target.id === "writing-input") $("#character-count").textContent = `${event.target.value.length} / 280`;
    if (event.target.id === "brush-size") app.drawing.size = Number(event.target.value);
  });

  document.addEventListener("change", (event) => {
    const input = event.target.closest("[data-setting]");
    if (!input || !app.state?.is_host) return;
    let value = input.type === "checkbox" ? input.checked : Number(input.value);
    action("set_settings", { key: input.dataset.setting, value });
  });

  document.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (event.target.id === "create-form") {
      const form = new FormData(event.target);
      try { const result = await request("/api/rooms", { method: "POST", body: JSON.stringify({ name: form.get("name"), color: form.get("color") }) }); await enterRoom(result.code, result.player_id); toast("Room created — invite your friends!", "success"); }
      catch (error) { toast(error.message, "error"); }
    }
    if (event.target.id === "join-form") {
      const form = new FormData(event.target);
      try { const result = await request("/api/rooms/join", { method: "POST", body: JSON.stringify({ code: form.get("code"), name: form.get("name"), color: form.get("color") }) }); await enterRoom(result.code, result.player_id); toast("You picked up the phone!", "success"); }
      catch (error) { toast(error.message, "error"); }
    }
    if (event.target.id === "chat-form" || event.target.id === "game-chat-form") {
      const input = event.target.querySelector("input"); if (input?.value.trim()) { await action("chat", { text: input.value }); input.value = ""; }
    }
  });

  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !$("#modal-layer").hidden) closeModal(); });
  setInterval(updateTimer, 500);

  (async function boot() {
    await loadConfig();
    const params = new URLSearchParams(location.search);
    const saved = (() => { try { return JSON.parse(localStorage.getItem("garlicphone-session")); } catch (_) { return null; } })();
    // A saved player can reconnect to a room; a plain invite link opens the join dialog.
    if (saved?.code && saved?.playerId) {
      try { await enterRoom(saved.code, saved.playerId); return; } catch (_) { clearSession(); }
    }
    showScreen("landing-screen");
    if (params.get("room")) setTimeout(() => joinModal(params.get("room")), 180);
  })();
})();
