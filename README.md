# KOHRA: fog-of-war decision trainer

Prototype for Smart India Hackathon 2026, PS 26248 (Immersive Multi-Domain Decision-Making Trainer for Degraded Communication Environments).

Commanders rarely get a complete picture. KOHRA keeps the truth on the server and gives every trainee a delayed, partial and sometimes contradictory version of it, then records exactly what each person knew when they decided.

## Run it in VS Code

1. Install Node.js 18 or newer from https://nodejs.org (check with `node -v` in a terminal).
2. Unzip the folder, then in VS Code choose **File > Open Folder** and pick the `kohra` folder.
3. Open the built-in terminal (**Terminal > New Terminal**) and run:

       node server.js 8080

   Or press **F5** and choose "Run KOHRA server (port 8080)".
4. Open http://localhost:8080 in your browser. Choose **Instructor**, press **Start** (or **Run demo**), and open the same address in more tabs or on other devices to join as trainees. Use the same room code on every device.
5. Other devices on the same Wi-Fi: use your computer's IP address instead of `localhost`, for example http://192.168.1.20:8080 (find it with `ipconfig` on Windows or `ifconfig` on Mac/Linux). You may need to allow Node through the firewall.

No `npm install` is needed. To stop the server press Ctrl+C in the terminal.

Without any server, just double-click `kohra-standalone.html`.

## Run it (other options)

**Multiplayer (needs Node 18 or newer, no npm install):**

    node server.js 8080

Open http://localhost:8080 on each device (same Wi-Fi: use the host's IP). Everyone enters the same room code, picks a role, and the instructor starts the exercise. One instructor plus up to four trainee roles.

**Single device, no server:** open `kohra-standalone.html` in any browser. You play one role at a time (switch from the top bar). As instructor, press **Run demo** to watch a scripted team play a full exercise in about a minute.

## What maps to the problem statement

| Expected outcome | Where it lives |
|---|---|
| Scenario engine that injects delay, dropout and conflicting reports mid-exercise | `engine.js`: `route()` (degradation middleware), `inject()`, scripted `timeline` in the scenario |
| Multiplayer team coordination under degraded information | `server.js` (WebSocket rooms) and the team net, which is itself degraded; reports can be shared to teammates |
| Instructor dashboard | Instructor screen: presets, per-link delay/loss/conflict sliders, jam / spoof / cut / intrusion buttons, live decision feed with scores |
| Exportable AAR with individual and team decision timelines and rationale | AAR screen: perception-gap chart, link statistics, decision table (what they knew vs truth, rationale, result, quality), JSON / CSV / print-to-PDF; also `GET /api/aar?room=CODE` and `/api/aar.csv` |

## How it works

- `engine.js` holds the whole simulation and is shared by the server and the browser (UMD). It is deterministic for a given seed, so exercises can be repeated exactly.
- The server is authoritative. Trainee clients only ever receive their own *perceived* view (delivered reports, their own units, link ages), never ground truth.
- Every report is routed to each recipient independently through the link's degradation: loss, delay with jitter, contradicting copies from an "unconfirmed source", position corruption, and spoofing (a consistent false offset). Orders and their acknowledgements travel the same degraded links, so an order can silently vanish.
- Four roles: Company Commander (radio), Air Liaison (UAV datalink), Cyber Officer, EW Officer. Cyber and EW decisions change the situation for everyone (isolating the datalink stops spoofing but also cuts UAV reports; a frequency hop reduces radio jamming).
- Each decision is scored against ground truth *and* against what the trainee knew: acting firmly on confirmed, fresh, consistent reports scores well; committing irreversible fire on thin or contradictory reports does not; verifying under doubt is rewarded. The score is a training aid with the formula visible in `finish()`, not a ruling.

## Scenario: Op Ridge Crossing (8 min)

An enemy armoured column moves on the bridge. Scripted events: radio jamming (T+1:00), enemy gets into the UAV datalink (T+2:30), UAV positions spoofed (T+3:30), datalink jamming (T+5:00). Strike or fire on a stale or spoofed position and you miss, or hit your own forces.

## Protocol (JSON over WebSocket `/ws?room=CODE`)

Client to server: `join`, `order`, `chat`, `ctl` (instructor: start, pause, reset, speed, preset, param, scripted, demo), `inject` (instructor), `getAar`.
Server to client: `joined`, `view`, `orderResult`, `aar`, `error`.

## Limits of this prototype

2D web map only (WebXR is the planned immersive layer); one scenario; rule-based adjudication, not a physics model; no authentication (run on a trusted network); state is in memory.

## Files

`engine.js` simulation | `server.js` HTTP + WebSocket | `index.html` client | `kohra-standalone.html` single-file build (`python3 build_standalone.py`) | `test_engine.js` headless checks
