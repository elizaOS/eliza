# Issue #12587 Evidence: Containers Product Port Publishing

## Scope

- Restored the Containers product Hetzner lane to publish Docker host ports as `-p hostPort:containerPort`.
- Kept Apps/Product 2 loopback-only publishing unchanged; Apps still use node-local Caddy to dial `127.0.0.1:hostPort`.
- Kept the #12468 container hardening flags (`--cap-drop=ALL`, `no-new-privileges`, `--pids-limit`) in the Containers `docker create` paths.
- No database schema, route DTO, UI, billing, model, native, wallet, audio, or on-chain behavior changed.

## Commands Reviewed

```bash
bun test packages/cloud/shared/src/lib/services/containers/hetzner-client/port-publish.test.ts
```

Result: passed; 2 tests passed.

```bash
bunx @biomejs/biome check packages/cloud/shared/src/lib/services/containers/hetzner-client/port-publish.ts packages/cloud/shared/src/lib/services/containers/hetzner-client/port-publish.test.ts packages/cloud/shared/src/lib/services/containers/hetzner-client/client.ts
```

Result: passed; 3 files checked, no fixes applied.

```bash
git diff --check
```

Result: passed.

```bash
rg -n "buildLoopbackPortPublishFlag|127\\.0\\.0\\.1:.*hostPort|buildContainerPortPublishFlag" packages/cloud/shared/src/lib/services/containers/hetzner-client/client.ts packages/cloud/shared/src/lib/services/containers/hetzner-client/port-publish.ts packages/cloud/shared/src/lib/services/containers/hetzner-client/port-publish.test.ts
```

Result: reviewed; `client.ts` calls `buildContainerPortPublishFlag(...)` in both initial create and `setEnv` recreate paths, and no longer references `buildLoopbackPortPublishFlag`.

## Blocked Or Unrelated Gates

```bash
bun test packages/cloud/shared/src/lib/services/containers/hetzner-client/port-publish.test.ts packages/cloud/shared/src/lib/services/__tests__/app-network-utils.test.ts packages/cloud/shared/src/lib/services/__tests__/app-docker-cmd.test.ts
```

Result: the new Containers test passed, but the broader related Apps tests could not load in this checkout because importing the shared helpers pulled `packages/core/src/cloud-routing.ts`, which failed to resolve `@elizaos/cloud-routing`.

```bash
bun run --cwd packages/cloud/shared typecheck
```

Result: blocked by broad existing workspace dependency declaration failures, including missing declarations for `drizzle-orm`, `pg`, and `@elizaos/auth/*` modules resolved from the linked root install. Filtered output showed no errors in `containers/hetzner-client/client.ts` or `containers/hetzner-client/port-publish.ts`.

## N/A Evidence

- Live Hetzner deployment: N/A - no Hetzner node or production cloud credentials are available in this environment.
- UI screenshots, video, frontend logs, and app audit: N/A - no UI code changed.
- Real-LLM trajectories: N/A - no agent prompt, model, provider, evaluator, or action behavior changed.
- Backend request traces and DB rows: N/A - this change is pure Docker command construction for the remote node execution path; no route or persistence logic changed.
- Native/mobile/desktop capture, audio, wallet, and on-chain evidence: N/A - those surfaces are untouched.
