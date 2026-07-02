# #10832 — plugin-pty Phase 2: gated interactive Claude/Codex CLI via PTY_SERVICE

Evidence for PR "feat(plugin-pty): Phase 2 — gated interactive Claude/Codex CLI
spawn specs (#10832)".

| Artifact | What it proves |
| --- | --- |
| `live-vendor-cli-smoke.ts` | The live smoke driver: calls the REAL `ptyRoutes` spawn handler with a REAL `PtyService` (true bun PTY spawn) against the REAL installed `claude` and `codex` binaries — no mocks, no fake PTY. |
| `live-vendor-cli-smoke.txt` | Its output, reviewed by hand: (1) `kind=claude` with the gate at its default → **HTTP 403** naming `PTY_VENDOR_CLI_ENABLED`; (2) `ELIZA_BUILD_VARIANT=store` with the gate explicitly on → **HTTP 403**; (3) gate on, `kind=claude` → **HTTP 200** and the real interactive Claude Code trust-folder TUI streaming on the PTY (`command=/home/shaw/.local/bin/claude`, `args=[]` — plain TUI, no `--print`); (4) gate on, `kind=codex` → **HTTP 200** and the real interactive Codex trust-directory TUI (`args=[]`, no `codex exec`). Both sessions then stopped cleanly through the service. |
| `vitest-plugin-pty.txt` | `bunx vitest run` in `plugins/plugin-pty`: **5 files, 88 tests passed** — includes the new `vendor-cli-spec.test.ts` (spec builders + bin resolvers) and the vendor-tier route tests (gate default-off, fail-closed on unrecognized truthy-ish values, store-build rejection, credential passthrough end-to-end through the store env allowlist, no-cloud-key requirement, missing-CLI guidance). |
| `vitest-cockpit-terminal.txt` | `bunx vitest run src/CockpitInteractiveTerminal.test.tsx` in `plugins/plugin-task-coordinator`: **11 tests passed** — same surface spawns the vendor kinds without a cerebras tier and surfaces the server's gate rejection. |

N/A — video walkthrough / before-after screenshots: the change is a server-side
route/spec tier plus an optional `kind` prop on the existing
`CockpitInteractiveTerminal`; no shipped view renders the vendor kinds yet (the
gate defaults off), so there is no reachable UI state to record. The live PTY
transcript above is the rendered-output equivalent for a terminal feature.
