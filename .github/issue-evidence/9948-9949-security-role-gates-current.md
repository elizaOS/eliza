# #9948 / #9949 - current branch validation rollup

Date: 2026-06-30 UTC
Branch: `fix/9948-9949-security-role-gates`

## Validation Run

Passed after `bun install` and rebasing on the then-current `origin/develop`:

```bash
bun run verify
```

Result: `495 successful, 495 total` in Turbo in `44m44.419s`, followed by passing build-model, Turbo dependency, TEE secret leak, script, and dist-path consumer audits. The dist-path check covered `28` consumer configs.

The verify run also regenerated the action-doc specs for the latest `plugin-cloud-apps` actions and applied Biome formatting/import ordering in current-base files. Those generated/formatting deltas were reviewed and kept with this branch so a fresh verify does not leave the tree dirty.

## Focused Checks

Passed:

```bash
bun test packages/core/src/features/trust/__tests__/should-respond-risk-gate.test.ts packages/core/src/roles.test.ts packages/core/src/security/external-content.test.ts
bun run --cwd packages/agent test -- src/api/public-route-audit.test.ts src/api/auth-routes.role.test.ts
node node_modules/vitest/vitest.mjs run --config packages/app-core/vitest.config.ts --pool=threads packages/app-core/src/api/__tests__/ensure-min-role.test.ts packages/app-core/src/api/__tests__/ensure-route-min-role.test.ts
bun run --cwd packages/ui lint
bun run --cwd packages/cloud/api lint
bun run --cwd packages/cloud/shared lint
```

Additional runner observations:

- The default `packages/app-core` Vitest command hung in the default pool on this host, but the same tests passed with `--pool=threads` (`14` tests).
- The targeted `packages/ui` and `plugin-wallet` Vitest commands hung during runner startup in both default and threads modes on this host. Their lint/build/typecheck paths passed inside root `bun run verify`; `plugin-wallet:lint` and `plugin-wallet:build` were explicitly reached in that root run.
- `packages/cloud/api/__tests__/containers-reserved-env.test.ts` logic reached passing assertions after the reserved-env guard, but the first hook group exceeded the host's 5s hook timeout under load; the cloud-api lint gate passed after template-string formatting.

## Evidence Status

- #9949 live-model trajectory/logs: `.github/issue-evidence/9949-should-respond-injection-gate.md`.
- #9948 backend and role-boundary tests: covered by the focused checks above plus root `verify`.
- #9948 UI screenshots: existing same-day artifacts remain in `.github/issue-evidence/9948-rolegate/` and `.github/issue-evidence/9948-shell-rolewiring/`; this branch did not change `packages/app/`.
- Real-LLM trajectory for #9948: N/A; the #9948 work is HTTP role/wallet/UI authorization, not model behavior.
- Audio/native-device artifacts: N/A; no audio, mobile bridge, or native-device behavior changed in this branch.
