# @elizaos/contracts

Pure TypeScript type contracts for elizaOS. Zero runtime code, zero runtime dependencies.

## What it is

This package contains the shared type definitions used across the elizaOS monorepo. Its direct dependents are `@elizaos/core` and `@elizaos/shared`. Types that need to be referenced by both the runtime and client-side packages (the web dashboard reaches them transitively through `@elizaos/shared`) live here so neither side has to depend on the full runtime.

## What it contains

| Module | What it defines |
|---|---|
| `cloud-topology` | `ElizaCloudService`, `ResolvedElizaCloudTopology` — how the local runtime sees its relationship to Eliza Cloud |
| `deployment` | `DeploymentTargetRuntime`, `DeploymentTargetConfig` — local / cloud / remote deployment shapes |
| `roles` | `RoleName` (`OWNER > ADMIN > USER > GUEST`), `RolesWorldMetadata`, `RolesConfig` |
| `service-routing` | `LinkedAccountConfig`, `LinkedAccountProviderId`, `ServiceRouteConfig`, `ServiceRoutingConfig`, `ServiceCapability`, `ServiceTransport` |
| `style` | `CharacterLanguage`, `StylePreset`, `MessageExample` — character/persona shapes consumed by onboarding and the character loader |
| `wallet` | EVM + Solana balances, NFTs, BSC trade execution (quote/execute/transfer), Steward vault, trading-profile ledger, market overview |

All logic that operates on these types — normalization, validation, resolution — lives in `@elizaos/core` or the owning service package.

## Installation

This package is part of the elizaOS monorepo and is published to npm under the `@elizaos` scope. It is a workspace dependency — other packages reference it via `"@elizaos/contracts": "workspace:*"` in their `package.json`.

```bash
# In an external project
npm install @elizaos/contracts
```

## Usage

```ts
import type { RoleName, ServiceRoutingConfig, WalletConfigStatus } from '@elizaos/contracts';

// Role hierarchy
const role: RoleName = 'ADMIN'; // 'OWNER' | 'ADMIN' | 'USER' | 'GUEST'

// Service routing shape
const routing: ServiceRoutingConfig = {
  llmText: { backend: 'anthropic', transport: 'direct', accountId: 'acct_123' },
};

// Wallet config shape consumed by the dashboard
const status: WalletConfigStatus = { evmAddress: '0x...', solanaAddress: null, ... };
```

`@elizaos/core` re-exports a cherry-picked subset of these types. For new code outside `@elizaos/core`, import directly from `@elizaos/contracts`.

## Build

```bash
bun run --cwd packages/contracts build     # emit dist/
bun run --cwd packages/contracts typecheck # type-check only
bun run --cwd packages/contracts clean     # remove dist/
```
