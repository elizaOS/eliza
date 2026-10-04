# @elizaos/host

Shared host configuration, boot aliases and HTTP plugin lifecycle. Hosts install
route lifecycle explicitly and own authentication, storage and model composition.

Use `@elizaos/host` for Node HTTP helpers and `@elizaos/host/protocol` for
browser-safe contracts and configuration. `@elizaos/host/native-host` exposes
Node-only SQLite task gateways, research collection and trace transport, database
leases, and verified document-runtime packaging. Consumers supply authentication,
consent, measurement policy and lifecycle ownership. Internal code imports defining files.

From the repository root, run `bun run --cwd packages/host build`,
`bun run --cwd packages/host test` and `bun run --cwd packages/host typecheck`.
