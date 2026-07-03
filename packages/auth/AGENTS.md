# @elizaos/auth — agent guide

Leaf auth package: account credential storage, OAuth/subscription flows,
direct-API-key probing, refresh mutex, and atomic-JSON helpers.

**Dependency rule (load-bearing):** this package is a LEAF below both
`@elizaos/agent` and `@elizaos/app-core`. It may import only `@elizaos/core`,
`@elizaos/shared`, and node builtins. It must NEVER import `@elizaos/agent` or
`@elizaos/app-core` — doing so re-introduces the cycle this package was extracted
to break (see #12091 item 3). Consumers import concrete subpaths
(`@elizaos/auth/credentials`, `@elizaos/auth/account-storage`, …).
