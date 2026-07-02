# Evidence — #11040 cockpit tap-in terminal broken end-to-end on develop

Environment: develop tip `bc6bb0ea81`, real dev stack (`bun run dev`, agent
:31337 + UI :2138), `@elizaos/plugin-pty` enabled via the ElizaConfig
`plugins.allow` list, Playwright Chromium at a phone viewport (390×844).
The proof drives the REAL path only: real cockpit route, real view bundle
served by the agent, real PTY spawn of the built eliza-code, real WS
`pty-input`/`pty-output`, real Eliza Cloud model turn. Nothing mocked.

## Root cause 1 — view-bundle lazy chunks vs host-external loader (pre-fix capture)

Tapping "⌨ Terminal · Fast" spawned the PTY (POST /api/pty/sessions → 200)
but the pane stayed blank. Captured page errors:

```
[pageerror] TypeError: Failed to resolve module specifier "@elizaos/ui".
            Relative references must start with either "/", "./", or "../".
[pageerror] TypeError: Failed to resolve module specifier "@elizaos/ui". …
```

Two rejections = the two lazy imports in `PtyTerminalPane`
(`import("@xterm/xterm")`, `import("@xterm/addon-fit")`). The built chunks
each contain `import { t as e } from "./bundle.js"`; the browser loaded the
entry as `bundle.js?hostExternalRuntime=1&…` (rewritten), so the chunk's
query-less `./bundle.js` re-fetched the RAW bundle whose bare
`import … from "@elizaos/ui"` cannot resolve in a browser. DOM check
confirmed `.xterm` never mounted (`{"xtermExists":false}`).

Fix: `packages/scripts/view-bundle-vite.config.ts` sets
`output.inlineDynamicImports: true` — one self-contained module per view
bundle (cockpit bundle: 592.8 kB, gzip 127.4 kB). Post-fix DOM check:
`{"xtermExists":true,"xtermRect":{"width":390,"height":616,…}}`.

## Root cause 2 — Bun executes a types-only .d.ts via tsconfig paths (A/B capture)

With the pane mounted, the spawned CLI died instantly. A/B through the real
PTY route (`POST /api/pty/sessions` → read `buffered-output`):

WITHOUT `dist/tsconfig.json`:

```
3 | export default openaiPlugin;
                   ^
ReferenceError: openaiPlugin is not defined
      at /home/nubs/Git/wt-sec/plugins/plugin-openai/dist/index.d.ts:3:16
```

WITH the emitted paths-free `dist/tsconfig.json` (same spawn, same env):

```
┌──────────────────────────────────────────────────────────────────┐
│ > ──────────────────────────────────────────────────────────────│
└──────────────────────────────────────────────────────────────────┘
Enter: send • Tab: tasks • Esc: clear • ?: help
```

The real interactive TUI boots. Fix: `packages/examples/code` build emits
`dist/tsconfig.json` (`{"compilerOptions":{}}`) via
`scripts/write-dist-tsconfig.mjs`, shadowing the package tsconfig (which
extends `tsconfig.dist-paths.json` and maps the externalized
`@elizaos/plugin-*` to `dist/*.d.ts` — right for tsc, fatal for `bun
dist/index.js`).

## Root cause 3 — TUI aborts at phone width (pre-fix capture)

43-column PTY (python `pty.fork` + `TIOCSWINSZ`, exact plugin env):

```
error: Rendered line 35 exceeds terminal width (44 > 43).
Debug log written to: ~/.pi/agent/pi-crash.log
      at doRender (…/packages/examples/code/dist/index.js:4934:17)
```

`pi-crash.log` names the composer row: `[35] (w=44) │ > ─…─│` — ChatPane
rendered the editor at `innerWidth` then added `│ > … │` chrome on top
(always width+1); the help footer `[37] (w=47)` was next in line to crash.

Fixes: ChatPane renders the editor at `innerWidth - 3`; MainScreen clips
every assembled line with the TUI's own `truncateToWidth` at the single
choke point. Post-fix at 43 cols: `CRASHED: False`, TUI renders and accepts
input.

## End-to-end proof after all fixes (browser, phone viewport)

```
✓ cockpit view rendered with Terminal button
✓ xterm pane mounted after spawn
✓ real CLI output streamed into xterm
✓ keystrokes round-tripped
✓ REAL model reply (pong) rendered in the terminal
   — "You 22:23  reply with exactly the word pong"
     "Eliza 22:23  pong"          (gpt-oss-120b via Eliza Cloud)
VERDICT: pass
```

Artifacts: `11040-cockpit-view-phone.png` (live cockpit deck + Terminal
buttons at 390×844), `11040-terminal-tui-phone-width.png` (eliza-code TUI
inside the cockpit xterm), `11040-real-model-reply-pong.png` (the model
round-trip), `11040-proof-result.json` (step-by-step machine-readable run).

## Model-pin knob (deploy-lag)

The spec default `DEFAULT_CEREBRAS_TEXT_MODEL` = `gemma-4-31b` (#10733) is
not yet servable by the DEPLOYED cloud — probed live:

```
model=gemma-4-31b  → {"error":{"message":"Unauthenticated. Configure AI_GATEWAY_API_KEY …"}}
model=gpt-oss-120b → {"choices":[{"message":{"content":"Ok."}…            (works)
```

develop's cloud code already maps bare `gemma-4-31b` → cerebras-direct
(`packages/cloud/shared/src/lib/providers/language-model.ts:431`), so this
is deploy-lag, not a code bug. `PTY_ELIZA_CLOUD_FAST_MODEL` /
`PTY_ELIZA_CLOUD_SMART_MODEL` let a deployment pin a servable model
meanwhile (session label confirms: `eliza-code · fast · gpt-oss-120b`).

## Kill-switch hardening

`PTY_INTERACTIVE_ENABLED` was case-sensitive and fail-open (`=FALSE`,
`=off`, `=no` left interactive spawning ON). Now trimmed + lowercased and
fail-closed: an explicit value enables only on `true|1|on|yes`. Unset keeps
the documented default (on, except store builds). plugin-pty suite: 49/49
green.

## No regressions

- `plugins/plugin-pty`: 49/49 tests green post-change; `tsgo --noEmit` clean.
- `packages/examples/code`: `tsgo --noEmit` clean; biome clean.
- Cockpit UI components on develop tip: 37/37 green (`packages/ui`
  `src/components/cockpit`), plugin-task-coordinator suite 49/49 green.
- View bundle rebuilds to a single module; `/cockpit` (deck + both terminal
  tiers) exercised live post-change.

## N/A rows

- Video walkthrough: N/A — headless CI-style Playwright run; the five
  full-page phone screenshots + the machine-readable step log cover the
  same flow frame-by-frame.
- Live-LLM trajectory capture: N/A for the three crashes (no
  agent/action/prompt behavior involved — module loading, runtime module
  resolution, and TUI layout). The one model-behavior claim (a real cloud
  turn works end-to-end) is evidenced by the rendered `pong` reply and the
  live `/v1/chat/completions` probes above.
- Desktop screenshots: N/A — the regression under test is the phone-width
  cockpit; desktop rendering was unaffected (wide terminals never hit the
  width guard, and the chunk bug is viewport-independent — fixed and
  re-verified at 390×844 which exercises the same loader path).
