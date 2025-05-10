# Solana Plugin V2 for Eliza 🌟

The **Solana Plugin V2** leverages the latest features of `@solana/web3.js` v2 to provide a modern, efficient, and composable solution for Solana integrations within the Eliza AI agent framework.

---

## Key Features 🚀

### Modern JavaScript and Functional Architecture
- **@solana/web3.js v2** introduces:
  - Tree-shakability
  - Composable internals
  - Zero-dependency design
  - Functional programming approach

### Compatibility with existing solana V1 plugins
- This plugin can be used by the agent alongside existing plugins that use `@solana/web3.js` v1.

### Common Utilities
The `Utils` class provides shared functionality across the plugin, offering flexibility and ease of integration.

#### `sendTransaction`
- Accepts the RPC instance, transaction instructions, and a wallet.
- Utilizes Solana's Compute Budget Program for optimized CU usage and priority fees.
- Implements client-side retry logic to enhance transaction landing success.
- More details on optimizing transactions can be found [here](https://orca-so.github.io/whirlpools/Whirlpools%20SDKs/Whirlpools/Send%20Transaction).

#### Trusted Execution Environment (TEE)
- For Trusted Execution Environment (TEE) functionality, this plugin transitions from `Keypair` (used in v1) to `CryptoKeyPair` from the Web Crypto API. This change aligns with `@solana/web3.js` v2's zero-dependency, modern JavaScript architecture.
- A modified implementation for TEE integration is included in `src/utils/`, following the same patterns used in `plugin-tee`.

---

## Current Functionality 🎯

### Liquidity Position Management
- **Reposition Liquidity**:
  - Automatically repositions Orca liquidity positions if the center price of the position deviates from the current pool price by more than a user-specified threshold (`repositionThresholdBps`).
  - Maintains the original width of the position during repositioning.
  - Repositions at a user defined time interval.
  - Uses a slippage tolerance set by the user.

### How to run the Orca LP Management tool
#### 1. Set up your environment variables
- In the root of the repositorty, copy `.env.example` to `.env`
- Fill in the following parameters:
  - `SOLANA_PRIVATE_KEY`
  - `SOLANA_PUBLIC_KEY`
  - `SOLANA_RPC_URL`
  - `OPENAI_API_KEY`

#### 2. RPC requirements
Most often, free-tier RPC URLs are not sufficient for this plugin.
- Eliza needs to fetch all your token-accounts in order to find the position NFTs that represent Orca positions. Such calls are done through the `getProgramAccounts` method of the RPC client, which can be expensive.
- To ensure transaction landing, the plugin makes use of a client-side retry logic (read more [here](https://www.helius.dev/blog/how-to-land-transactions-on-solana#how-do-i-land-transactions)), which also puts a heavier load on the RPC.
- The amount of positions you own and the update interval you set can also contribute to RPC limits.

#### 3. Update the agent
In `agent/src/index.ts`, search for the function `createAgent`, and add `solana_plugin_v2` to the `AgentRuntime` like so:
```typescript
export async function createAgent(
    character: Character,
    db: IDatabaseAdapter,
    cache: ICacheManager,
    token: string
): Promise<AgentRuntime> {
    // Rest of the code ...

    return new AgentRuntime({
        // Other parameters
        plugins: [
            // Other plutins
            getSecret(character, "SOLANA_PUBLIC_KEY") ||
            (getSecret(character, "WALLET_PUBLIC_KEY") &&
                !getSecret(character, "WALLET_PUBLIC_KEY")?.startsWith("0x"))
                ? solanaPluginV2
                : null,
    // Rest of the code
```

#### 4. Use LP Manager character
Copy `packages/plugin-solana-v2/src/character/orca/lpmanager.character.json` to `characters/lpmanager.character.json`.

#### 5. Install and build the repo
Follow the general installation and build steps from the README in the root of the repo

#### 5. Run the agent
Start the agent with the following command:
```sh
pnpm start --characters="characters/lpmanager.character.json"
```

Start the client (chat terminal) with:
```sh
pnpm start:client
```

#### 6. Start prompting
Ask the agent what it can do for you. Provide the appropriate parameters and let the agent reposition your positions automatically.

#### 7. Other configurations
In `packages/plugin-solana-v2/src/utils/sendTransaction.ts`, you can set the priority fees. They are by default set to use the dynamic fees, but you can adjust this as you like.

## Future Functionality 🔮

### Position Management Enhancements
- **Opening and Closing Positions**:
  - Expose opening and closing positions as separate actions.
  - Allow agents to leverage data streams and other plugins for decision-making and yield optimization.

### Token Launches
- **Token Creation and Liquidity Setup**:
  - Create tokens with metadata using the Token 2022 Program.
  - Launch tokens on Orca with single-sided liquidity.
  - Configure start and maximum prices for initial liquidity.

---

## Contributing 🤝
Contributions are welcome! If you wish to extend `plugin-solana-v2` with your tools, ensure compatibility with `@solana/web3.js` v2.

---
