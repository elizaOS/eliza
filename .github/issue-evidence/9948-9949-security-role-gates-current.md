# #9948 / #9949 - current branch validation rollup

Date: 2026-06-30 UTC
Branch: `fix/9948-9949-security-role-gates`

## Validation Run

Passed after `bun install`, rebasing on `origin/develop`
(`8e09d5b709b`), and applying the final current-base lint/typecheck drift
fixes:

```bash
bun run verify
```

Result: `495 successful, 495 total` in Turbo in `5m32.495s`, followed by passing build-model, Turbo dependency, TEE secret leak, script, and dist-path consumer audits. The dist-path check covered `28` consumer configs.

The verify run also regenerated the action-doc specs for the latest `plugin-cloud-apps` actions and applied Biome formatting/import ordering in current-base files. The final rebase additionally exposed `exactOptionalPropertyTypes` failures in the setting wrappers for `plugin-embeddings`, `plugin-edge-tts`, `plugin-elizacloud`, and `plugin-x`; each wrapper now omits the `defaultValue` option when the caller did not provide one. Those generated/formatting/current-base deltas were reviewed and kept with this branch so a fresh verify does not leave the tree dirty.

The type-safety ratchet passed below baseline:

- `as unknown as`: `81 / 83`
- `as any`: `0 / 0`
- explicit `: any` annotation: `126 / 126`
- `@ts-expect-error` / `@ts-ignore`: `0 / 0`
- non-null assertions: `556 / 565`
- `?? ""` in core/agent/app-core: `624 / 627`
- `?? []` in core/agent/app-core: `588 / 588`
- `?? {}` in core/agent/app-core: `377 / 377`
- `?? 0` in core/agent/app-core: `382 / 386`

## Focused Checks

Passed:

```bash
bun test packages/core/src/features/trust/__tests__/should-respond-risk-gate.test.ts packages/core/src/roles.test.ts packages/core/src/security/external-content.test.ts
bun run --cwd packages/agent test -- src/api/public-route-audit.test.ts src/api/auth-routes.role.test.ts
node node_modules/vitest/vitest.mjs run --config packages/app-core/vitest.config.ts --pool=threads packages/app-core/src/api/__tests__/ensure-min-role.test.ts packages/app-core/src/api/__tests__/ensure-route-min-role.test.ts
bun run --cwd packages/ui lint
bun run --cwd packages/ui typecheck
bun run --cwd packages/cloud/api lint
bun run --cwd packages/cloud/shared lint
bun run --cwd packages/elizaos lint
bun run --cwd packages/elizaos typecheck
bun run --cwd plugins/plugin-embeddings lint
bun run --cwd plugins/plugin-embeddings typecheck
bun run --cwd plugins/plugin-edge-tts lint
bun run --cwd plugins/plugin-edge-tts typecheck
bun run --cwd plugins/plugin-elizacloud lint
bun run --cwd plugins/plugin-elizacloud typecheck
bun run --cwd plugins/plugin-x lint
bun run --cwd plugins/plugin-x typecheck
bun run audit:type-safety-ratchet
```

Additional runner observations:

- The default `packages/app-core` Vitest command hung in the default pool on this host, but the same tests passed with `--pool=threads` (`14` tests).
- The targeted `packages/ui` and `plugin-wallet` Vitest commands hung during runner startup in both default and threads modes on this host. Their lint/build/typecheck paths passed inside root `bun run verify`; `plugin-wallet:lint` and `plugin-wallet:build` were explicitly reached in that root run.
- `packages/cloud/api/__tests__/containers-reserved-env.test.ts` logic reached passing assertions after the reserved-env guard, but the first hook group exceeded the host's 5s hook timeout under load; the cloud-api lint gate passed after template-string formatting.

## Evidence Status

- #9949 live-model trajectory/logs: `.github/issue-evidence/9949-should-respond-injection-gate.md` (latest run `50792b71-9327-4ba9-bbde-198f24e3a09f`, provider `openai`, `1 passed / 0 failed / 0 skipped`).
- #9948 backend and role-boundary tests: covered by the focused checks above plus root `verify`.
- #9948 UI screenshots: existing same-day artifacts remain in `.github/issue-evidence/9948-rolegate/` and `.github/issue-evidence/9948-shell-rolewiring/`; this branch did not change `packages/app/`.
- Real-LLM trajectory for #9948: N/A; the #9948 work is HTTP role/wallet/UI authorization, not model behavior.
- Audio/native-device artifacts: N/A; no audio, mobile bridge, or native-device behavior changed in this branch.
