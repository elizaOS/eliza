# @elizaos/core

The Node runtime kernel: plugin registration, authorization, state composition,
model dispatch, memory, cancellation and effect settlement.

## Entry points

| Import                                                                 | Contents                                                                                           |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `@elizaos/core`                                                        | The Node runtime (`AgentRuntime`), plugin and service types, model request guards                  |
| `@elizaos/core/protocol`                                               | Browser-safe contracts and pure helpers, including `TaskEventReader` and `admitTaskChoiceResponse` |
| `@elizaos/core/logging`                                                | Logger types and credential redaction for browser log sinks                                        |
| `@elizaos/core/security/redact`                                        | Secret and credential redaction                                                                    |
| `@elizaos/core/speech`                                                 | Speech text helpers and structured speech errors                                                   |
| `@elizaos/core/view-interaction`                                       | Renderer routing and completed-action handoff contracts                                            |
| `@elizaos/core/task-events`, `@elizaos/core/task-widgets`              | Task activity and task choice widget contracts                                                     |
| `@elizaos/core/read-memo`                                              | `SingleFlightMemo`, the read coalescing used by runtime reads                                      |
| `@elizaos/core/schema-types`                                           | JSON value, action-parameter schema and view-capability types (type-only)                          |
| `@elizaos/core/permissions`                                            | Permission IDs, types and guards                                                                   |
| `@elizaos/core/catalog/*.json`, `@elizaos/core/restart-exit-code.json` | Shipped data catalogs                                                                              |

The leaf entries load without the full protocol catalog. Every other module is
private; internal modules import their defining files directly.

## Boundaries

Core imports no host. HTTP lifecycle, platform detection, process guards,
restart, application configuration and boot environment live in `@elizaos/host`
(browser-safe configuration in `@elizaos/host/protocol`); acoustic processing in
`@elizaos/voice`; cross-domain DTOs in `@elizaos/contracts`. Hosts compose
database adapters, model providers and `@elizaos/plugin-assistant` explicitly.

Runtime settings are per-agent; per-agent values take precedence over the few
explicit host environment fallbacks (secret/PII master switches and process
execution policies). Model context, authorization evidence and effect receipts
stay complete.

Production string settings require an explicit `SECRET_SALT` other than the
historical public value `secretsalt`. `ELIZA_ALLOW_DEFAULT_SECRET_SALT` no longer
changes this check. Keep the existing private salt to retain access to encrypted
settings. Migrate settings encrypted with the public value before upgrading;
changing the salt alone does not re-encrypt them. Outside production, an unset
or historical salt uses one random key for that process. It does not persist
across process restarts. Hosts must retain a private salt for persistent data.

## Development

Integration tests live in `test/`. `scripts/verify-package.ts` packs the package
into a temporary consumer and checks the published exports and runtime
initialization. Live model checks are opt-in (`test:e2e`, `*.live.test.ts`).

```bash
bun run --cwd packages/core build
bun run --cwd packages/core test
bun run --cwd packages/core test:quint
bun run --cwd packages/core typecheck
bun run --cwd packages/core lint:check
```
