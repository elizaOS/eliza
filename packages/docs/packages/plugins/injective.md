# @elizaos/plugin-injective

A comprehensive plugin for interacting with the Injective chain through ElizaOS.

## Project Structure

```
src/
├── auction.ts            # Auction module actions
├── auth.ts              # Auth module actions
├── bank.ts              # Bank module actions
├── distribution.ts      # Distribution module actions
├── exchange.ts          # Exchange module actions
├── explorer.ts          # Explorer module actions
├── gov.ts              # Governance module actions
├── ibc.ts              # IBC module actions
├── insurance.ts         # Insurance module actions
├── mint.ts             # Mint module actions
├── mito.ts             # Mito module actions
├── peggy.ts            # Peggy module actions
├── permissions.ts       # Permissions module actions
├── staking.ts          # Staking module actions
├── token-factory.ts     # Token Factory module actions
├── wasm.ts             # WASM module actions
├── base.ts             # Base action creation logic
└── index.ts            # Main export file
```

## Module Organization

Each module file follows a consistent organization pattern:

### 1. File Structure
```typescript
// src/[module].ts

import { createGenericAction } from './base';
import * as ModuleTemplates from '@injective/template/[module]';
import * as ModuleExamples from '@injective/examples/[module]';

// Export individual actions
export const Action1 = createGenericAction({...});
export const Action2 = createGenericAction({...});

// Export all actions as a group
export const ModuleActions = [
    Action1,
    Action2,
    // ...other actions
];
```

### 2. Main Export File
```typescript
// src/index.ts

export * from './auction';
export * from './auth';
// ...other module exports

export const InjectiveActions = [
    ...ExchangeActions,
    ...AuctionActions,
    // ...other module actions
];
```

## Module Descriptions

### auction.ts
Handles auction-related functionality including module parameters, auction rounds, and bidding.

### auth.ts
Manages authentication, account details, and authorization grants.

### bank.ts
Handles account balances, token transfers, and supply queries.

### distribution.ts
Manages reward distribution and withdrawals.

### exchange.ts
Core exchange functionality including spot/derivative markets, orders, and positions.

### explorer.ts
Blockchain explorer functionality including transaction and block queries.

### gov.ts
Handles protocol governance including proposals and voting.

### ibc.ts
Inter-Blockchain Communication functionality.

### insurance.ts
Manages insurance funds and redemptions.

### mint.ts
Controls token minting and inflation parameters.

### mito.ts
Handles Mito-specific functionality.

### peggy.ts
Manages Ethereum bridge operations.

### permissions.ts
Controls role-based access and permissions.

### staking.ts
Manages validator operations and delegations.

### token-factory.ts
Handles token creation and management.

### wasm.ts
Smart contract functionality including deployment and execution.

## Development

### Adding New Actions

1. Add action to appropriate module file:
```typescript
export const NewAction = createGenericAction({
    name: 'ACTION_NAME',
    description: 'Action description',
    template: Templates.template,
    examples: Examples.example,
    functionName: 'functionName',
    validateContent: () => true
});

export const ModuleActions = [
    ...existingActions,
    NewAction
];
```

### Adding New Modules

1. Create new module file:
```typescript
// src/new-module.ts
export const NewModuleActions = [...];
```

2. Add to main exports:
```typescript
// src/index.ts
export * from './new-module';
```

## Installation

```bash
npm install @elizaos/plugin-injective
```

## Usage

```typescript
import { InjectiveActions } from '@elizaos/plugin-injective';
```

## Contributing
Feel free to contribute to more similes, examples and refined templates - for a more robust action contorl.

1. Fork the repository
2. Create your feature branch
3. Commit your changes
4. Push to the branch
5. Create a Pull Request

## License

ISC