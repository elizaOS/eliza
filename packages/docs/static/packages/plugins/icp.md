# @elizaos/plugin-icp

## Purpose

Internet Computer Protocol (ICP) plugin for Eliza OS.

## Key Features

- Create meme tokens on PickPump
- Interact with ICP canisters
- Handle ICRC-1 token standard
- Manage ICP wallets and identities
- Support for anonymous and authenticated calls

## Installation

```bash
bun install @elizaos/plugin-icp
```

## Configuration

The plugin requires the following environment variables:

```env
INTERNET_COMPUTER_PRIVATE_KEY=<your-ed25519-private-key>
```

## Integration

```typescript
import { icpPlugin } from '@elizaos/plugin-icp';

// Register the plugin with Eliza
eliza.registerPlugin(icpPlugin);
```

## Example Usage

```typescript
// Example usage in chat
'Create a space cat token on PickPump';
'Help me create a pizza-themed funny token on PP';
```

## Dependencies

- @dfinity/agent: ^2.1.3
- @dfinity/candid: ^2.1.3
- @dfinity/identity: ^2.1.3
- @dfinity/principal: ^2.1.3
- @elizaos/core: workspace:\*
