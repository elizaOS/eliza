# app-counter

A trivial counter app that doubles as the end-to-end fixture for the unified
`APP` action's `create` / `launch` / `relaunch` flow.

The runtime plugin (`src/plugin.ts`) exposes four actions:

- `INCREMENT_COUNTER` — `+1` (or `+N` via `{ by: N }` option).
- `DECREMENT_COUNTER` — `−1` (or `−N`).
- `GET_COUNTER` — read the current value.
- `RESET_COUNTER` — set to 0.

State is persisted to `<state-dir>/app-counter.json` via a tiny
`CounterStore` so the value survives process restarts. State-dir resolution
matches the rest of Milady (`MILADY_STATE_DIR` / `ELIZA_STATE_DIR` if set,
else `~/.milady`).

The UI (`src/index.tsx`) is a 60-line React shell with `+1` / `−1` / reset
buttons and a `localStorage`-backed local mirror.

Run the tests:

```bash
cd eliza/apps/app-counter && bun test
```
