# Documentation Coverage Matrix

This file maps every package under `packages/` to its docs-site coverage. Maintained as a contract: when a new user-facing package lands, add it here and add a doc page. When a package is deliberately internal, list it under "Intentionally omitted" with a one-line reason.

## Covered (user-facing)

| Package                          | Dimension | Primary doc surface                                                  |
| -------------------------------- | --------- | -------------------------------------------------------------------- |
| `packages/os/`                   | OS        | `tracks/elizaos/{overview,linux,aosp,install}.mdx`                   |
| `packages/core/`                 | Runtime   | `runtime/*.mdx`, `tracks/framework/*.mdx`                            |
| `packages/agent/`                | Runtime   | `tracks/agent/*.mdx`, `agents/*.mdx`                                 |
| `packages/elizaos/` (CLI)        | Runtime   | `cli/{overview,create-project,create-plugin}.mdx`                    |
| `packages/training/` (Eliza-1)   | Runtime   | `tracks/training/{overview,eliza-1,benchmarks}.mdx`                  |
| `packages/scenario-runner/`      | Runtime   | `plugins/scenarios.md`                                               |
| `packages/skills/`               | Runtime   | `plugins/skills.md`, `skills/streaming.md`                           |
| `packages/prompts/`              | Runtime   | (consumed by `runtime/*`; no standalone page needed)                 |
| `packages/app/`                  | App       | `tracks/agent-app/*.mdx`, `apps/*.md`                                |
| `packages/app-core/`             | App       | `tracks/agent-app/*.mdx`, `apps/dashboard/*`, `guides/onboarding-*`  |
| `packages/ui/`                   | App       | `apps/ui-library.md`                                                 |
| `packages/tui/`                  | App       | (terminal UI; folded into `apps/*` desktop coverage)                 |
| `packages/homepage/`             | App       | (marketing site; no in-docs coverage by design)                      |
| `packages/os-homepage/`          | App       | (marketing site; no in-docs coverage by design)                      |
| `packages/cloud-api/`            | Cloud     | `tracks/cloud/*.mdx`                                                 |
| `packages/cloud-frontend/`       | Cloud     | `tracks/cloud/overview.mdx`, `guides/cloud.md`                       |
| `packages/cloud-sdk/`            | Cloud     | `tracks/cloud/*.mdx`                                                 |
| `packages/cloud-shared/`         | Cloud     | (shared schemas; consumed by cloud track)                            |
| `packages/chip/`                 | Chip      | `tracks/chip/*.mdx`                                                  |
| `packages/robot/`                | Robot     | `tracks/training/robot.mdx`                                          |
| `packages/feed/`                 | Robot     | `tracks/training/feed.mdx`                                           |
| `packages/benchmarks/`           | Robot     | `tracks/training/benchmarks.mdx`                                     |
| `packages/vault/`                | Runtime   | `guides/wallet.md`, `guides/platform-secure-store.md`                |

## Intentionally omitted (internal)

These packages exist in the monorepo but should NOT appear in the docs site:

| Package                                | Reason                                                              |
| -------------------------------------- | ------------------------------------------------------------------- |
| `packages/workflows/`                  | Type contracts for plugin consumption; not user-facing.             |
| `packages/contracts/`                  | Pure type definitions extracted from core; internal.                |
| `packages/native/`                     | Internal runtime + plugin implementations.                          |
| `packages/bun-ios-runtime/`            | Internal iOS runtime detail; surfaced via mobile docs only.         |
| `packages/electrobun-carrots/`         | Private. Internal carrot primitives for desktop shells.             |
| `packages/browser-bridge-extension/`   | Private. Internal browser extension.                                |
| `packages/swe-bench-workspace/`        | Test infrastructure artifact.                                       |
| `packages/shared/`                     | Internal shared utilities.                                          |
| `packages/cloud-infra/`                | Kubernetes/Terraform infrastructure; private.                       |
| `packages/cloud-routing/`              | Private infrastructure routing.                                     |
| `packages/cloud-services/`             | Empty / not present.                                                |
| `packages/scripts/`                    | Build / release orchestration; documented in repo READMEs only.     |
| `packages/test/`                       | Cross-package test fixtures.                                        |
| `packages/scenario-runner/` (internal) | Schema authoring goes to plugin authors; covered in `plugins/scenarios`. |
| `packages/examples/`                   | Reference snippets; linked from track pages, not separately indexed.|

## Contract

- Every package that lands in `packages/` must have an entry here within the same PR.
- If the package is user-facing, the PR adds a doc page (or extends an existing one) and updates the table above.
- If the package is internal, the PR adds a one-line justification under "Intentionally omitted."
- The `bun test packages/docs/test` test suite verifies nav integrity.
- `npx mintlify broken-links` verifies no dead in-docs links.
