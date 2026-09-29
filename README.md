# Garlic Phone

A dependency-free web remake of the telephone game: write prompts, draw interpretations, and reveal the chain of beautiful nonsense.

## Run it

Garlic Phone only needs Python 3.10+ — there are no packages to install.

```bash
python3 server.py
```

The server reads its port from `port.txt` (currently `8000`) and binds to `0.0.0.0`, so it is available at `http://YOUR-IP:8000` on a local network. To use another port, change the single number in `port.txt` and restart the server.

## Included

- Create and join rooms with five-character invite codes
- Lobby presence, host controls, ready status, invite copying, and live chat
- Normal, Knock-Off, Secret, Animation, Icebreaker, Score, Complement, Sandwich, Background, Solo, and Crowd modes
- Configurable rounds, turn timer, and family-friendly setting
- Text prompts, responsive drawing canvas, pen/eraser, colors, brush size, undo/redo, and clear
- Private in-progress turns so other players cannot peek
- Reveal gallery with complete telephone chains, reactions, star ratings, and score-mode voting
- Mobile-friendly layout with no account or external service required

For development, syntax-check the server with `python3 -m py_compile server.py` and open `/api/health` after starting it.
