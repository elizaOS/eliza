# @elizaos/test-corpus

This package owns only repository-wide scenario definitions and shared Vitest
lane configuration. It is not a runtime, harness, mock service, or general test
utility package.

## Layout

- `scenarios/` contains cross-package scenario definitions consumed by
  `@elizaos/scenario-runner`.
- `vitest/` contains workspace-wide Vitest lane configuration and source alias
  resolution shared by package-local test suites.

Put deterministic model behavior and runtime construction in
`@elizaos/core/testing`. Put external API recordings and mock servers in
`packages/scenario-runner/test/mocks`. Put product-specific fixtures beside the
product that owns them. Put cloud integration infrastructure under
`packages/cloud`.

Do not add exports or production dependencies here. Tests should import the
real elizaOS runtime and opt into an explicit model-provider plugin when a
deterministic model response is required.
