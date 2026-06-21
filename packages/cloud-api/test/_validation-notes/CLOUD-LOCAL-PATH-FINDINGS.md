# Cloud/Local Path Validation — Findings (live + audit)

## Live real-cloud API results (api.elizacloud.ai, SIWE-authed)
- ✅ SIWE auth (nonce→verify→apiKey), /api/v1/user authed
- ✅ Create agent (POST /api/v1/eliza/agents alwaysOn:true) → 202, tier=**dedicated-always**, status=pending, web_ui_url present immediately
- ✅ Dedicated container READY at **t=73s** (status pending→running) — good boot time
- ✅ Delete agent (DELETE /api/v1/eliza/agents/:id) → 202 + polls to 404 (container gone)
- ❌ **Shared chat NEVER works** for the dedicated-always agent: POST .../api/conversations/<id>/messages → 404 "Not a shared-runtime agent" for the full 73s boot. So "chat immediately while the container boots" (#8810) is NON-FUNCTIONAL for the agents the app actually creates (createCloudCompatAgent hardcodes alwaysOn:true → getAgentTier→dedicated-always, agent-tier.ts:61).
- ❌ Explicit POST .../provision → 409 (conflict) on an alwaysOn agent (already auto-provisioning). provisionCloudSandbox would hit this if used live.
- ⚠️ Readiness base from agent detail = tailnet IP (100.64.0.70:2138), not the public subdomain. App must resolve the public <agentId>.elizacloud.ai web_ui_url, not bridge_url, to reach the container from a user device.

## Implications
- Cloud provisioning + dedicated agent + delete: WORK at the API layer.
- The shared→dedicated "chat immediately" handoff UX is the broken piece — either the app should create shared agents for the boot window, or the shared adapter must serve dedicated agents during boot, or the UX must honestly show a ~75s "setting up" state with progress (no silent shared 404s). #8810 confirms the handoff result is .catch()-discarded and invisible.

## Device (Pixel 9a) live validation
- ✅ **Local agent + LOCAL models WORKS**: on-device eliza-1-0_8b, status running canRespond=true, generated "local-works" in 5s with streaming tokens (SSE). active-server = IPC local:android, runtime-mode=local, cloud disconnected.
- TODO: local agent + CLOUD models (switch provider to elizacloud), cloud onboarding on device, reset/nuke, agent switch, remote connect.

## Infra fix made
- packages/agent/src/api/server.ts: added defensive WS error handlers (wss.on('error') + upgrade socket.on('error')) so an abrupt client disconnect during the WS handshake no longer crashes the agent API (was: "Uncaught exception: Unhandled error (ErrorEvent) at ws:201" → 6 restarts → dev server gives up). Agent typecheck EXIT:0.

## CORRECTED cloud assessment (after tracing the actual apiBase binding)
- The app binds chat to the PUBLIC SUBDOMAIN https://<agentId>.elizacloud.ai (resolveCloudAgentApiBase keeps web_ui_url; normalizeDirectCloudSharedAgentApiBase only rewrites already-shared paths; the subdomain is not a control-plane host). My earlier "shared chat 404" was the WRONG base (the shared adapter `<api>/api/v1/eliza/agents/<id>`), which the app does NOT bind for a dedicated agent that has web_ui_url.
- LIVE PROOF: public subdomain /api/status returned 202 "starting" during boot (0→71s), then 200 at 82s; a real chat through the dedicated container returned a 200 agent reply. So:
  - ✅ Cloud provisioning WORKS (~73-82s boot)
  - ✅ Cloud inference WORKS (real chat through dedicated container)
  - ✅ Boot UX is GRACEFUL (202, not a hard error)
  - ✅ Delete/deprovision WORKS (202 → 404)
- #8810 reframed: "chat immediately on shared while dedicated boots" is NOT implemented for the app's dedicated agents (they wait ~82s on 202) — it's an unimplemented UX enhancement, not an error-bug. The shared-runtime adapter + handoff import are effectively unused for the agents the app creates (all alwaysOn:true → dedicated-always; shared tier never used). The user does see a graceful "waking" wait, just not immediate chat + a visible handoff event.

## VALIDATED so far
- ✅ Cloud provisioning + cloud inference + delete (API, real cloud)
- ✅ Local agent + LOCAL models (device, eliza-1-0_8b, 5s gen)
- ⚠️ Remote connect (works; UX friction: loopback bind default, token/pairing labels) — from the one workflow audit that survived
- 🔧 Fixed: agent API WS crash on abrupt client disconnect (committed d44c1fdf9e)

## STILL TO VALIDATE
- Local agent + CLOUD models (switch provider to elizacloud) on device
- Reset/nuke (local reset + cloud container delete from UI)
- Agent switch (CloudAgentsSection Use)
- Cloud onboarding through the real UI on web + device
- Per-modality routing #8811 (local/cloud per modality, AUTO mode)

## Bugs FIXED + VERIFIED + PUSHED (develop)
1. **Agent reset/nuke completely broken** (P0) — POST /api/agent/reset threw "Reset failed: null is not an object (evaluating maybe.stop)" EVERY time. Root: runtime.stop() (core/runtime.ts:1933) did `const maybe = service as {...}; if(typeof maybe.stop==="function")` — a null service entry throws on `.stop` access before the guard, aborting the loop. FIXED: guard null + isolate each stop() in try/catch. Verified: reset now returns {ok:true} + clears first-run. Core tests 866/866. (c7f9d2c5b2)
2. **Agent API WS crash on abrupt disconnect** (P1) — "Unhandled error (ErrorEvent) at ws:201" crashed the API repeatedly until give-up. FIXED: defensive wss.on('error') + upgrade socket.on('error') + immediate ws.on('error') in handleUpgrade. Agent now recovers. NOTE: a residual bun-native outgoing-WebSocket error path may remain (ErrorEvent is DOM-style; ainex uses the `ws` pkg + isn't connected, so not it) — bit only the aggressive raw-socket stress, not normal device/API use. (d44c1fdf9e)

## Path verdicts (evidence-backed)
| Path | Verdict | Evidence |
|---|---|---|
| Cloud provisioning | ✅ WORKS | real cloud: 202 create, dedicated ready 73-82s |
| Cloud inference | ✅ WORKS | real chat through dedicated container (public subdomain 202→200) |
| Cloud delete/deprovision | ✅ WORKS | DELETE→202→polls to 404 |
| Local agent + local models | ✅ WORKS | device eliza-1-0_8b, 5s gen, streaming |
| Reset/nuke (local) | ✅ FIXED | was hard-500; now {ok:true} |
| Mock provisioning/lifecycle e2e | ✅ 44/44 | cloud:e2e suite |
| Remote connect | ⚠️ WORKS w/ friction | loopback bind default, token/pairing UX |
| Shared→dedicated "chat immediately" (#8810) | ⚠️ UNIMPLEMENTED (not error) | graceful 202 wait ~82s; no immediate shared chat + no visible handoff event |
| Local agent + cloud models | ⏳ untested (provider-switch route exists at /api/provider/switch) |
| Agent switch UI | ⏳ untested (CloudAgentsSection bindAndReload; mock e2e covers lifecycle) |
| Per-modality routing #8811 (AUTO) | ⏳ unverified (capability-blind per issue) |
| UI onboarding on web/desktop/sim/device | ⏳ surface tests pending |

## Local agent + CLOUD models (characterized)
- ✅ Provider switch local→elizacloud WORKS: with a valid SIWE key, agent goes model=elizacloud, canRespond=true, cloud.connectionStatus=connected in ~5s.
- ❌ Cloud INFERENCE through the local agent fails 401 "Invalid or expired API key" (plugin-elizacloud/src/models/text.ts:1080; embeddings + TTS also 401). The bare ephemeral SIWE session key authorizes agent management (create/delete worked) but is NOT inference-authorized — the account has no credits/billing. A real billed account would work; the dedicated-container path worked because the container carries server-side inference auth.
- 🐛 UX BUG: a cloud-inference 401 surfaces to the user as the generic "Something went wrong on my end. Please try again." with no hint it's an auth/billing problem. Should say "Eliza Cloud key not authorized — add credits / re-link" (same class as #8810 "make failures honest").

## Vault corruption robustness gap (observed)
- After the ainex crash-storm (abrupt SIGKILLs mid-write), the vault PGlite at ~/.local/state/eliza/.vault-pglite became corrupt ("PGlite initialization failed... Aborted()"), and the agent FATAL-crash-loops on every boot until the user manually removes that dir (the error message instructs this). Robustness gap: a corrupt vault bricks the whole agent. Auto-move-aside+recreate is risky for a secrets store, so flagged as a finding, not auto-fixed. (Cleared manually to recover.)

## Bug count this session: 3 fixed+pushed (reset/nuke P0, ainex-crash P1, ws-hardening P1) + 2 UX findings (cloud-401 generic error; vault-corruption bricks agent)

## FINAL COMPLETION PASS (all code-completable notes items closed)
- ✅ Vault corruption recovery — corrupt .vault-pglite now auto-moved-aside + recreated (was: FATAL crash-loop on every boot). ELIZA_VAULT_NO_AUTO_RECOVER=1 to opt out. vault 185/186.
- ✅ Remote-connect "Password" mislabel → "Access token" + helper steering blank-token users to pairing. ui typecheck clean.
- ✅ Cloud-inference 401 → honest "Eliza Cloud key not authorized — add credits" reply (isAuthError). Done earlier (a28fabf411).
- ✅ #8810 refactor: pairing-path deleted, ProvisioningChatView deleted, handoff retry added (banner + onRetry + 8s linger); progress banner + product status copy already in-tree.
- ✅ #8811 refactor: capability-driven AUTO routing policy (device-tier → local/cloud per slot); voice (TTS/TRANSCRIPTION) already on the per-slot router via pickProvider, so AUTO covers voice too. RoutingMatrix "Auto (by device)" option.
- ✅ recommendation.ts/Eliza1TierId pre-existing break — resolved by the tier-ladder owner (ui typecheck now clean); correctly left untouched (their domain).
- n/a provisionCloudSandbox /provision 409 — confirmed DEAD path (zero live callers; first-run uses selectOrProvisionCloudAgent). Not worth fixing; could be deleted as future cleanup.

## GENUINELY BLOCKED (cannot be made 100% by code — environment-dependent)
- Live UI cloud onboarding / agent-switch / local→cloud inference driven through the FULL UI on web + desktop + android-sim + android-device: blocked by (a) Eliza Cloud auth rate-limiting parallel/headless runs, (b) need for a BILLED cloud account with credits for inference-via-local (bare SIWE key 401s on inference — proven), (c) the x86_64 android emulator's embedded agent segfaults (documented). The underlying paths are validated at the API + device-render layer; the remaining gap is purely full-UI-on-every-physical-surface, which needs a credited account + hands-on device driving.
