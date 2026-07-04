# @elizaos/auth

Leaf auth package for Eliza agents. Owns account credential storage, OAuth /
subscription login flows, direct-API-key probing, refresh coordination, and the
atomic-JSON write helper those depend on.

It sits **below** `@elizaos/agent` and `@elizaos/app-core` so both consume it
without a dependency cycle. It depends only on `@elizaos/core`, `@elizaos/shared`,
and node builtins — never on `@elizaos/agent` or `@elizaos/app-core`.

## Public surface

- `account-storage` — on-disk account credential records (`saveAccount`, `loadAccount`, …).
- `credentials` — provider credential resolution + access-token acquisition.
- `oauth-flow` — interactive OAuth/subscription login flows.
- `direct-api-probe` — direct-API-key availability probing.
- `refresh-mutex` — per-account refresh serialization.
- `types` — shared account/provider types and id constants.
- `atomic-json` — secret-grade atomic JSON read/write helpers.

Import subpaths directly, e.g. `import { saveAccount } from "@elizaos/auth/account-storage"`.
