# Shared dev server for concurrent lanes

Parallel worktrees should not all bind the default app UI port (`2138`). The app Vite config uses `strictPort: true`, so a second server on the same port fails instead of auto-incrementing. Use the shared dev-server scripts when multiple agents or lanes are active on the same VPS.

## Commands

Run from `packages/app`:

```bash
bun run dev:shared   # long-lived Vite server on this worktree's deterministic port
bun run dev:status   # list running shared dev servers from the registry
bun run dev:rebuild  # explicit Vite full-reload trigger for this worktree
```

`bun run dev` is unchanged for single-lane local development.

## Port contract

`dev:shared` reserves a deterministic port from the worktree path and stores the reservation in `~/.eliza/dev-server-registry.json` (override with `ELIZA_DEV_SERVER_REGISTRY`). The UI port is allocated from `2100-2999`; the paired API port is `uiPort + 10000`. If two worktrees hash to the same port, the registry lock linear-probes to the next free port, so active lanes stay distinct.

The script exports `ELIZA_UI_PORT` and `ELIZA_API_PORT` before starting Vite, then records the Vite pid. `dev:status` checks both pid liveness and whether the UI port is open.

## Rebuild trigger

`dev:rebuild` is intentionally explicit. It requires a running shared server for the current worktree, then updates `packages/app/index.html` mtime. Vite watches the HTML shell and broadcasts a full reload to connected clients. This gives agents a cheap, composable "refresh now" hook without each lane starting another server.

## VPS workflow

1. Pick or create the worktree for your lane.
2. Start one long-lived server:

   ```bash
   cd packages/app
   bun run dev:shared
   ```

3. In another shell, discover the URL:

   ```bash
   bun run dev:status
   ```

4. Point the Cloudflare tunnel, browser, or installed PWA live-reload URL at that lane's UI port.
5. After source/build state changes that need a visible refresh, run:

   ```bash
   bun run dev:rebuild
   ```

If a stale process dies, `dev:status` hides it by default; use `bun run dev:status -- --all` to inspect stopped registry entries.
