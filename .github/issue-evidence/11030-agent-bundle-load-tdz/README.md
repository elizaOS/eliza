# #11030 / #10727 — agent-bundle.js load-time ReferenceError (mobile agent never starts)

Host-reproducible evidence for the P0 fixed by
`fix(core): sub-agent-credentials circular import crashes the mobile agent bundle at load`.

## Device failure

Pixel 6a (bun 1.3.14 musl arm64), agent-bundle.js built from develop `5dfde101fd`:

```
ReferenceError: declareSubAgentCredentialScopeAction is not defined
      at agent-bundle.js:165159 (inside: init_actions7(); subAgentCredentialsPlugin = { ... actions: [ declareSubAgentCredentialScopeAction, ...
```

The bun agent process dies at module init; `/api/health` never binds; the app
shows `local_agent_unavailable`. #11030 reports the same class of failure on a
real iPhone ("Booting up…" hang, load-time JS eval error).

## Host repro (no device)

On `origin/develop` (d49148fe05):

```
bun run --cwd packages/agent build:mobile
cd packages/agent/dist-mobile && bun -e 'await import("./agent-bundle.js")'
# → ReferenceError: declareSubAgentCredentialScopeAction is not defined  (agent-bundle.js:165371)
```

Pre-fix bundle facts: `init_actions7` compiled to an empty `() => {}`; the four
action module bodies were absent (`grep -c DECLARE_SUB_AGENT_CREDENTIAL_SCOPE` → 0)
while `plugin.ts`'s body (kept alive by the eager named import in
`packages/agent/src/runtime/eliza.ts`) still referenced the four bindings.

## Artifacts

- `prefix-red-smoke.log` — pre-fix source + the new fail-closed load smoke in
  `build-mobile-bundle.mjs`: build exits 1 on the ReferenceError.
- `postfix-green-load.log` — fixed bundle: module init completes
  (`BUNDLE_LOAD_SMOKE_OK` / boot proceeds to plugin resolution + PGlite).

Both logs were produced on a Linux x64 host with the exact staging build
(`bun run --cwd packages/agent build:mobile`, the same artifact
`stage-android-agent.mjs` ships to the device).
