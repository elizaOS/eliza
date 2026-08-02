# @elizaos/test-corpus

This package owns only repository-wide, cross-package scenario definitions. It
is not a runtime, harness, mock service, general test utility package, or home
for product-owned scenarios.

## Layout

- `scenarios/` contains cross-package scenario definitions consumed by
  `@elizaos/scenario-runner`.

Put deterministic model behavior and runtime construction in
`@elizaos/core/testing`. Put external API recordings and mock servers in
`packages/scenario-runner/test/mocks`. Put product-specific fixtures beside the
product that owns them. Put cloud integration infrastructure under
`packages/cloud`.

Workspace-wide Vitest lane configuration and source-alias resolution live in
`packages/scripts/vitest` with the rest of the repository automation.

Do not add exports or production dependencies here. Tests should import the
real elizaOS runtime and opt into an explicit model-provider plugin when a
deterministic model response is required.
