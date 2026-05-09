# Barrel Audit

Generated: 2026-05-09T22:04:30.324Z

## Summary

- Workspace packages: 147
- Source subpath import/export sites: 14
- Source subpath string references: 14
- Non-root package export entries: 29
- Planned import rewrites: 14
- Planned root barrel additions: 7
- Planned explicit export-map removals: 29
- Manual review items: 5

## Source Subpath Imports

### @elizaos/agent/services/plugin-installer (13)
- packages/app-core/src/services/plugin-installer.ts
- packages/app-core/src/services/plugin-installer.ts
- packages/app-core/src/services/plugin-installer.ts
- packages/app-core/src/services/plugin-installer.ts
- packages/app-core/src/services/plugin-installer.ts
- packages/app-core/src/services/plugin-installer.ts
- packages/app-core/src/services/plugin-installer.ts
- packages/app-core/src/services/plugin-installer.ts
- packages/app-core/src/services/plugin-installer.ts
- packages/app-core/src/services/plugin-installer.ts
- packages/app-core/src/services/plugin-installer.ts
- packages/app-core/src/services/plugin-installer.ts
- packages/app-core/src/services/plugin-installer.ts

### @elizaos/app-wallet/register (1)
- packages/app/src/main.tsx

## Source Subpath String References

### @elizaos/agent/services/plugin-installer (13)
- packages/app-core/src/services/plugin-installer.ts
- packages/app-core/src/services/plugin-installer.ts
- packages/app-core/src/services/plugin-installer.ts
- packages/app-core/src/services/plugin-installer.ts
- packages/app-core/src/services/plugin-installer.ts
- packages/app-core/src/services/plugin-installer.ts
- packages/app-core/src/services/plugin-installer.ts
- packages/app-core/src/services/plugin-installer.ts
- packages/app-core/src/services/plugin-installer.ts
- packages/app-core/src/services/plugin-installer.ts
- packages/app-core/src/services/plugin-installer.ts
- packages/app-core/src/services/plugin-installer.ts
- packages/app-core/src/services/plugin-installer.ts

### @elizaos/app-wallet/register (1)
- packages/app/src/main.tsx

## Non-Root Exports By Package

### @elizaos/app-core (10; explicit 10, wildcard 0, asset 0)
- ./api/auth -> ./dist/api/auth.js
- ./api/automation-node-contributors -> ./dist/api/automation-node-contributors.js
- ./api/client-base -> ./dist/api/client-base.js
- ./api/compat-route-shared -> ./dist/api/compat-route-shared.js
- ./api/response -> ./dist/api/response.js
- ./platform/empty-node-module -> ./dist/platform/empty-node-module.js
- ./runtime/app-route-plugin-registry -> ./dist/runtime/app-route-plugin-registry.js
- ./services/plugin-installer -> ./dist/services/plugin-installer.js
- ./services/steward-sidecar -> ./dist/services/steward-sidecar.js
- ./services/steward-sidecar/helpers -> ./dist/services/steward-sidecar/helpers.js

### @elizaos/app-wallet (10; explicit 7, wildcard 3, asset 0)
- ./ui -> ./dist/ui.js
- ./plugin -> ./dist/plugin.js
- ./register -> ./dist/register.js
- ./inventory/ChainIcon -> ./dist/inventory/ChainIcon.js
- ./inventory/TokenLogo -> ./dist/inventory/TokenLogo.js
- ./widgets/wallet-status -> ./dist/widgets/wallet-status.js
- ./wallet-rpc -> ./dist/wallet-rpc.js
- ./state/* -> ./dist/state/*.js (wildcard)
- ./inventory/* -> ./dist/inventory/*.js (wildcard)
- ./* -> ./dist/*.js (wildcard)

### @elizaos/plugin-browser (5; explicit 5, wildcard 0, asset 0)
- ./contracts -> ./dist/contracts.js
- ./packaging -> ./dist/packaging.js
- ./plugin -> ./dist/plugin.js
- ./schema -> ./dist/schema.js
- ./workspace -> ./dist/workspace/index.js

### @elizaos/agent (2; explicit 1, wildcard 1, asset 0)
- ./api/* -> ./src/api/*.ts (wildcard)
- ./services/plugin-installer -> ./src/services/plugin-installer.ts

### @elizaos/shared (1; explicit 1, wildcard 0, asset 0)
- ./config/allowed-hosts -> ./dist/config/allowed-hosts.js

### @elizaos/ui (1; explicit 1, wildcard 0, asset 0)
- ./platform/native-plugin-entrypoints -> ./dist/platform/native-plugin-entrypoints.js

## Planned Import Rewrites

- packages/app/src/main.tsx: @elizaos/app-wallet/register -> @elizaos/app-wallet
- packages/app-core/src/services/plugin-installer.ts: @elizaos/agent/services/plugin-installer -> @elizaos/agent
- packages/app-core/src/services/plugin-installer.ts: @elizaos/agent/services/plugin-installer -> @elizaos/agent
- packages/app-core/src/services/plugin-installer.ts: @elizaos/agent/services/plugin-installer -> @elizaos/agent
- packages/app-core/src/services/plugin-installer.ts: @elizaos/agent/services/plugin-installer -> @elizaos/agent
- packages/app-core/src/services/plugin-installer.ts: @elizaos/agent/services/plugin-installer -> @elizaos/agent
- packages/app-core/src/services/plugin-installer.ts: @elizaos/agent/services/plugin-installer -> @elizaos/agent
- packages/app-core/src/services/plugin-installer.ts: @elizaos/agent/services/plugin-installer -> @elizaos/agent
- packages/app-core/src/services/plugin-installer.ts: @elizaos/agent/services/plugin-installer -> @elizaos/agent
- packages/app-core/src/services/plugin-installer.ts: @elizaos/agent/services/plugin-installer -> @elizaos/agent
- packages/app-core/src/services/plugin-installer.ts: @elizaos/agent/services/plugin-installer -> @elizaos/agent
- packages/app-core/src/services/plugin-installer.ts: @elizaos/agent/services/plugin-installer -> @elizaos/agent
- packages/app-core/src/services/plugin-installer.ts: @elizaos/agent/services/plugin-installer -> @elizaos/agent
- packages/app-core/src/services/plugin-installer.ts: @elizaos/agent/services/plugin-installer -> @elizaos/agent

## Planned Root Barrel Additions

- packages/agent/src/index.ts: export * from "./services/plugin-installer"; (./services/plugin-installer)
- packages/app-core/src/index.ts: export * from "./platform/empty-node-module"; (./platform/empty-node-module)
- packages/app-core/src/index.ts: export * from "./runtime/app-route-plugin-registry"; (./runtime/app-route-plugin-registry)
- packages/app-core/src/index.ts: export * from "./services/plugin-installer"; (./services/plugin-installer)
- packages/app-core/src/index.ts: export * from "./services/steward-sidecar/helpers"; (./services/steward-sidecar/helpers)
- plugins/plugin-browser/src/index.ts: export * from "./workspace.js"; (./workspace)
- packages/ui/src/index.ts: export * from "./platform/native-plugin-entrypoints"; (./platform/native-plugin-entrypoints)

## Planned Explicit Export-Map Removals

- packages/agent/package.json: ./services/plugin-installer, ./api/*
- packages/app-core/package.json: ./api/auth, ./api/automation-node-contributors, ./api/client-base, ./api/compat-route-shared, ./api/response, ./platform/empty-node-module, ./runtime/app-route-plugin-registry, ./services/plugin-installer, ./services/steward-sidecar, ./services/steward-sidecar/helpers
- plugins/app-wallet/package.json: ./ui, ./plugin, ./register, ./inventory/ChainIcon, ./inventory/TokenLogo, ./widgets/wallet-status, ./wallet-rpc, ./state/*, ./inventory/*, ./*
- plugins/plugin-browser/package.json: ./contracts, ./packaging, ./plugin, ./schema, ./workspace
- packages/shared/package.json: ./config/allowed-hosts
- packages/ui/package.json: ./platform/native-plugin-entrypoints

## Manual Review

- @elizaos/agent ./api/*: wildcard export needs a package-level barrel decision
- @elizaos/app-core ./api/client-base: could not resolve export target to a source module (./dist/api/client-base.js)
- @elizaos/app-wallet ./state/*: wildcard export needs a package-level barrel decision
- @elizaos/app-wallet ./inventory/*: wildcard export needs a package-level barrel decision
- @elizaos/app-wallet ./*: wildcard export needs a package-level barrel decision

