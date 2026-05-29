# Keyboard Shortcuts

All shortcuts are safe to use during a screen share — none of them change the OS cursor or reveal the app window.

## Window control

| Shortcut | Action |
|---|---|
| `Alt + Shift + A` | Show / hide the app window (global — works even when app isn't focused) |
| `Ctrl + Shift + →` | Grow width |
| `Ctrl + Shift + ←` | Shrink width |
| `Ctrl + Shift + ↓` | Grow height |
| `Ctrl + Shift + ↑` | Shrink height |

**Resize step:** 30 px per tap, 15 px when held (auto-repeat).
**Size bounds:** clamped to min 320×220 and max 1400×1200.
**Anchor:** the bottom-right corner stays pinned — the window grows / shrinks from its top-left edge. This keeps the window inside the screen when it's docked in the bottom-right.

| Key | Visible effect |
|---|---|
| `Ctrl + Shift + →` | Left edge moves **left** (window gets wider) |
| `Ctrl + Shift + ←` | Left edge moves **right** (window gets narrower) |
| `Ctrl + Shift + ↓` | Top edge moves **up** (window gets taller) |
| `Ctrl + Shift + ↑` | Top edge moves **down** (window gets shorter) |

## Sending to Claude

| Shortcut | Action |
|---|---|
| `Ctrl + Enter` | Send the current input textarea to Claude |
| `⏹ Stop` button | Cancels the in-flight Claude response so you can send a new one |

## Why keyboard resize instead of dragging the edge?

Native window resize relies on the OS drawing a directional resize cursor (↔, ↕, ↗, ↘) at the window edges. That cursor is captured by screen-sharing apps (Zoom, Meet, Teams) **independently of `setContentProtection`**, because the cursor is a separate OS subsystem from the window's pixel surface.

To keep the app fully invisible on a share, we disable native resize (`resizable: false`) and resize via `Ctrl + Shift + Arrow` instead. No cursor shape changes → nothing leaks.
