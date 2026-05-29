# Building MeetingAI

## First-time setup

```powershell
npm install
```

Pulls in `electron` and `electron-builder` (~150 MB on first run, cached after).

## Build commands

| Command | Output |
|---|---|
| `npm run build` | Both installer and portable (default) |
| `npm run build:installer` | NSIS installer only |
| `npm run build:portable` | Portable .exe only |
| `npm run build:dir` | Unpacked `dist/win-unpacked/` folder (fastest — good for testing) |

## Output files

All builds land in `dist/`:

| File | What it is |
|---|---|
| `MeetingAI-1.0.0-setup.exe` | NSIS installer — runs the install wizard, adds Start Menu + Desktop shortcuts |
| `MeetingAI-1.0.0-portable.exe` | Single-file portable — double-click to run, no install needed |
| `win-unpacked/MeetingAI.exe` | Loose unpacked build — runs directly from the folder |

## Notes

- First build takes ~1–2 min (Electron binaries get cached to `%LOCALAPPDATA%\electron-builder\Cache`). Later builds are ~30s.
- No custom icon configured — Windows shows the default Electron icon. To add one: drop a 256×256 `build/icon.ico` and electron-builder auto-detects it.
- API keys (`ANTHROPIC_KEY`, `GROQ_KEY` in `renderer/app.js`) get packed into `app.asar` in the build. They are trivially extractable with `npx asar extract` — keep the .exe files private.
- The `dist/` folder is gitignored.

## Running the dev build

```powershell
npm start
```

Runs the app from source without building — same as developing locally.
