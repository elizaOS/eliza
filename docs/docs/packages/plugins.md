# 🧩 Plugins

## Overview

Eliza's plugin system provides a modular way to extend the core functionality with additional features, actions, evaluators, and providers. Plugins are self-contained modules that can be easily added or removed to customize your agent's capabilities.

## Core Plugin Concepts

### Plugin Structure

Each plugin in Eliza must implement the `Plugin` interface with the following properties:

```typescript
interface Plugin {
    name: string; // Unique identifier for the plugin
    description: string; // Brief description of plugin functionality
    actions?: Action[]; // Custom actions provided by the plugin
    evaluators?: Evaluator[]; // Custom evaluators for behavior assessment
    providers?: Provider[]; // Context providers for message generation
    services?: Service[]; // Additional services (optional)
}
```

## Using Plugins

### Installation

1. Install the desired plugin package:

```bash
pnpm add @elizaos/plugin-[name]
```

2. Import and register the plugin in your character configuration:

```typescript
import { bootstrapPlugin } from "@eliza/plugin-bootstrap";
import { imageGenerationPlugin } from "@eliza/plugin-image-generation";
import { buttplugPlugin } from "@eliza/plugin-buttplug";
const character = {
    // ... other character config
    plugins: [bootstrapPlugin, imageGenerationPlugin, buttplugPlugin],
};
```

---

### Available Plugins

#### 1. Bootstrap Plugin (`@eliza/plugin-bootstrap`)

The bootstrap plugin provides essential baseline functionality:

**Actions:**

- `continue` - Continue the current conversation flow
- `followRoom` - Follow a room for updates
- `unfollowRoom` - Unfollow a room
- `ignore` - Ignore specific messages
- `muteRoom` - Mute notifications from a room
- `unmuteRoom` - Unmute notifications from a room

**Evaluators:**

- `fact` - Evaluate factual accuracy
- `goal` - Assess goal completion

**Providers:**

- `boredom` - Manages engagement levels
- `time` - Provides temporal context
- `facts` - Supplies factual information

#### 2. Image Generation Plugin (`@eliza/plugin-image-generation`)

Enables AI image generation capabilities:

**Actions:**

- `GENERATE_IMAGE` - Create images based on text descriptions
- Supports multiple image generation services (Anthropic, Together)
- Auto-generates captions for created images

#### 3. Node Plugin (`@eliza/plugin-node`)

Provides core Node.js-based services:

**Services:**

- `BrowserService` - Web browsing capabilities
- `ImageDescriptionService` - Image analysis
- `LlamaService` - LLM integration
- `PdfService` - PDF processing
- `SpeechService` - Text-to-speech
- `TranscriptionService` - Speech-to-text
- `VideoService` - Video processing

#### 4. Solana Plugin (`@eliza/plugin-solana`)

Integrates Solana blockchain functionality:

**Evaluators:**

- `trustEvaluator` - Assess transaction trust scores

**Providers:**

- `walletProvider` - Wallet management
- `trustScoreProvider` - Transaction trust metrics

##### Charity Contributions

All Coinbase trades and transfers automatically donate 1% of the transaction amount to charity. Currently, the charity addresses are hardcoded based on the network used for the transaction, with the current charity being supported as X.

The charity addresses for each network are as follows:

- **Base**: `0x1234567890123456789012345678901234567890`
- **Solana**: `pWvDXKu6CpbKKvKQkZvDA66hgsTB6X2AgFxksYogHLV`
- **Ethereum**: `0x750EF1D7a0b4Ab1c97B7A623D7917CcEb5ea779C`
- **Arbitrum**: `0x1234567890123456789012345678901234567890`
- **Polygon**: `0x1234567890123456789012345678901234567890`

In the future, we aim to integrate with The Giving Block API to allow for dynamic and configurable donations, enabling support for a wider range of charitable organizations.

#### 5. Coinbase Commerce Plugin (`@eliza/plugin-coinbase`)

Integrates Coinbase Commerce for payment and transaction management:

**Actions:**

- `CREATE_CHARGE` - Create a payment charge using Coinbase Commerce
- `GET_ALL_CHARGES` - Fetch all payment charges
- `GET_CHARGE_DETAILS` - Retrieve details for a specific charge

**Description:**
This plugin enables Eliza to interact with the Coinbase Commerce API to create and manage payment charges, providing seamless integration with cryptocurrency-based payment systems.

---

##### Coinbase Wallet Management

The plugin automatically handles wallet creation or uses an existing wallet if the required details are provided during the first run.

1. **Wallet Generation on First Run**
   If no wallet information is provided (`COINBASE_GENERATED_WALLET_HEX_SEED` and `COINBASE_GENERATED_WALLET_ID`), the plugin will:

    - **Generate a new wallet** using the Coinbase SDK.
    - Automatically **export the wallet details** (`seed` and `walletId`) and securely store them in `runtime.character.settings.secrets` or other configured storage.
    - Log the wallet’s default address for reference.
    - If the character file does not exist, the wallet details are saved to a characters/charactername-seed.txt file in the characters directory with a note indicating that the user must manually add these details to settings.secrets or the .env file.

2. **Using an Existing Wallet**
   If wallet information is available during the first run:
    - Provide `COINBASE_GENERATED_WALLET_HEX_SEED` and `COINBASE_GENERATED_WALLET_ID` via `runtime.character.settings.secrets` or environment variables.
    - The plugin will **import the wallet** and use it for processing mass payouts.

---

#### 6. Coinbase MassPayments Plugin (`@eliza/plugin-coinbase`)

This plugin facilitates the processing of cryptocurrency mass payouts using the Coinbase SDK. It enables the creation and management of mass payouts to multiple wallet addresses, logging all transaction details to a CSV file for further analysis.

**Actions:**

- `SEND_MASS_PAYOUT`
  Sends cryptocurrency mass payouts to multiple wallet addresses.
    - **Inputs**:
        - `receivingAddresses` (array of strings): Wallet addresses to receive funds.
        - `transferAmount` (number): Amount to send to each address (in smallest currency unit, e.g., Wei for ETH).
        - `assetId` (string): Cryptocurrency asset ID (e.g., `ETH`, `BTC`).
        - `network` (string): Blockchain network (e.g., `base`, `sol`, `eth`, `arb`, `pol`).
    - **Outputs**: Logs transaction results (success/failure) in a CSV file.
    - **Example**:
        ```json
        {
            "receivingAddresses": [
                "0xA0ba2ACB5846A54834173fB0DD9444F756810f06",
                "0xF14F2c49aa90BaFA223EE074C1C33b59891826bF"
            ],
            "transferAmount": 5000000000000000,
            "assetId": "ETH",
            "network": "eth"
        }
        ```

**Providers:**

- `massPayoutProvider`
  Retrieves details of past transactions from the generated CSV file.
    - **Outputs**: A list of transaction records including the following fields:
        - `address`: Recipient wallet address.
        - `amount`: Amount sent.
        - `status`: Transaction status (`Success` or `Failed`).
        - `errorCode`: Error code (if any).
        - `transactionUrl`: URL for transaction details (if available).

**Description:**

The Coinbase MassPayments plugin streamlines cryptocurrency distribution, ensuring efficient and scalable payouts to multiple recipients on supported blockchain networks.

Supported networks:

- `base` (Base blockchain)
- `sol` (Solana)
- `eth` (Ethereum)
- `arb` (Arbitrum)
- `pol` (Polygon)

**Setup and Configuration:**

1. **Configure the Plugin**
   Add the plugin to your character's configuration:

    ```typescript
    import { coinbaseMassPaymentsPlugin } from "@eliza/plugin-coinbase-masspayments";

    const character = {
        plugins: [coinbaseMassPaymentsPlugin],
    };
    ```

2. **Required Configurations**
   Set the following environment variables or runtime settings:

    - `COINBASE_API_KEY`: API key for Coinbase SDK
    - `COINBASE_PRIVATE_KEY`: Private key for secure transactions
    - `COINBASE_GENERATED_WALLET_HEX_SEED`: Hexadecimal seed of the wallet (if using existing wallet)
    - `COINBASE_GENERATED_WALLET_ID`: Unique wallet ID (if using existing wallet)

**Wallet Management:**

The plugin handles wallet creation and management in two ways:

1. **Automatic Wallet Creation**
   When no wallet details are provided, the plugin will:

    - Generate a new wallet using the Coinbase SDK
    - Export and store the wallet details in `runtime.character.settings.secrets`
    - Save details to `characters/charactername-seed.txt` if character file doesn't exist
    - Log the wallet's default address

2. **Using Existing Wallet**
   When wallet information is available:
    - Provide the required wallet details via settings or environment variables
    - The plugin will import and use the existing wallet

**Example Configuration:**

```typescript
// For automatic wallet generation
runtime.character.settings.secrets = {
    // Empty settings for first run
};

// For using existing wallet
runtime.character.settings.secrets = {
    COINBASE_GENERATED_WALLET_HEX_SEED:
        "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
    COINBASE_GENERATED_WALLET_ID: "wallet-id-123",
};
```

**Example Call**

```typescript
const response = await runtime.triggerAction("SEND_MASS_PAYOUT", {
    receivingAddresses: [
        "0xA0ba2ACB5846A54834173fB0DD9444F756810f06",
        "0xF14F2c49aa90BaFA223EE074C1C33b59891826bF",
    ],
    transferAmount: 5000000000000000, // 0.005 ETH
    assetId: "ETH",
    network: "eth",
});
console.log("Mass payout response:", response);
```

**Transaction Logging**

All transactions (successful and failed) are logged to a `transactions.csv` file in the plugin’s working directory:

```plaintext
Address,Amount,Status,Error Code,Transaction URL
0xA0ba2ACB5846A54834173fB0DD9444F756810f06,5000000000000000,Success,,https://etherscan.io/tx/0x...
```

**Example Output:**

When successful, a response similar to the following will be returned:

```json
{
    "text": "Mass payouts completed successfully.\n- Successful Transactions: 2\n- Failed Transactions: 0\nCheck the CSV file for more details."
}
```

**Best Practices:**

- **Secure Secrets Storage**: Ensure `COINBASE_API_KEY` and `COINBASE_PRIVATE_KEY` are stored securely in `runtime.character.settings.secrets` or environment variables. Either add `COINBASE_GENERATED_WALLET_HEX_SEED`, and `COINBASE_GENERATED_WALLET_ID` from a previous run, or it will be dynamically created
- **Validation**: Always validate input parameters, especially `receivingAddresses` and `network`, to ensure compliance with expected formats and supported networks.
- **Error Handling**: Monitor logs for failed transactions or errors in the payout process and adjust retry logic as needed.

---

#### 7. Coinbase Token Contract Plugin (`@eliza/plugin-coinbase`)

This plugin enables the deployment and interaction with various token contracts (ERC20, ERC721, ERC1155) using the Coinbase SDK. It provides functionality for both deploying new token contracts and interacting with existing ones.

**Actions:**

1. `DEPLOY_TOKEN_CONTRACT`
   Deploys a new token contract (ERC20, ERC721, or ERC1155).

    - **Inputs**:
        - `contractType` (string): Type of contract to deploy (`ERC20`, `ERC721`, or `ERC1155`)
        - `name` (string): Name of the token
        - `symbol` (string): Symbol of the token
        - `network` (string): Blockchain network to deploy on
        - `baseURI` (string, optional): Base URI for token metadata (required for ERC721 and ERC1155)
        - `totalSupply` (number, optional): Total supply of tokens (only for ERC20)
    - **Example**:
        ```json
        {
            "contractType": "ERC20",
            "name": "MyToken",
            "symbol": "MTK",
            "network": "base",
            "totalSupply": 1000000
        }
        ```

2. `INVOKE_CONTRACT`
   Invokes a method on a deployed smart contract.
    - **Inputs**:
        - `contractAddress` (string): Address of the contract to invoke
        - `method` (string): Method name to invoke
        - `abi` (array): Contract ABI
        - `args` (object, optional): Arguments for the method
        - `amount` (number, optional): Amount of asset to send (for payable methods)
        - `assetId` (string, optional): Asset ID to send
        - `network` (string): Blockchain network to use
    - **Example**:
        ```json
        {
          "contractAddress": "0x123...",
          "method": "transfer",
          "abi": [...],
          "args": {
            "to": "0x456...",
            "amount": "1000000000000000000"
          },
          "network": "base"
        }
        ```

**Description:**

The Coinbase Token Contract plugin simplifies the process of deploying and interacting with various token contracts on supported blockchain networks. It supports:

- ERC20 token deployment with customizable supply
- ERC721 (NFT) deployment with metadata URI support
- ERC1155 (Multi-token) deployment with metadata URI support
- Contract method invocation for deployed contracts

All contract deployments and interactions are logged to a CSV file for record-keeping and auditing purposes.

**Usage Instructions:**

1. **Configure the Plugin**
   Add the plugin to your character's configuration:

    ```typescript
    import { tokenContractPlugin } from "@eliza/plugin-coinbase";

    const character = {
        plugins: [tokenContractPlugin],
    };
    ```

2. **Required Configurations**
   Ensure the following environment variables or runtime settings are configured:
    - `COINBASE_API_KEY`: API key for Coinbase SDK
    - `COINBASE_PRIVATE_KEY`: Private key for secure transactions
    - Wallet configuration (same as MassPayments plugin)

**Example Deployments:**

1. **ERC20 Token**

    ```typescript
    const response = await runtime.triggerAction("DEPLOY_TOKEN_CONTRACT", {
        contractType: "ERC20",
        name: "MyToken",
        symbol: "MTK",
        network: "base",
        totalSupply: 1000000,
    });
    ```

2. **NFT Collection**

    ```typescript
    const response = await runtime.triggerAction("DEPLOY_TOKEN_CONTRACT", {
        contractType: "ERC721",
        name: "MyNFT",
        symbol: "MNFT",
        network: "eth",
        baseURI: "https://api.mynft.com/metadata/",
    });
    ```

3. **Multi-token Collection**
    ```typescript
    const response = await runtime.triggerAction("DEPLOY_TOKEN_CONTRACT", {
        contractType: "ERC1155",
        name: "MyMultiToken",
        symbol: "MMT",
        network: "pol",
        baseURI: "https://api.mymultitoken.com/metadata/",
    });
    ```

**Contract Interaction Example:**

```typescript
const response = await runtime.triggerAction("INVOKE_CONTRACT", {
  contractAddress: "0x123...",
  method: "transfer",
  abi: [...],
  args: {
    to: "0x456...",
    amount: "1000000000000000000"
  },
  network: "base"
});
```

**Best Practices:**

- Always verify contract parameters before deployment
- Store contract addresses and deployment details securely
- Test contract interactions on testnets before mainnet deployment
- Keep track of deployed contracts using the generated CSV logs
- Ensure proper error handling for failed deployments or interactions

---

#### 8. TEE Plugin (`@elizaos/plugin-tee`)

Integrates [Dstack SDK](https://github.com/Dstack-TEE/dstack) to enable TEE (Trusted Execution Environment) functionality and deploy secure & privacy-enhanced Eliza Agents:

**Providers:**

- `deriveKeyProvider` - Allows for secure key derivation within a TEE environment. It supports deriving keys for both Solana (Ed25519) and Ethereum (ECDSA) chains.
- `remoteAttestationProvider` - Generate a Remote Attestation Quote based on `report_data`.

**DeriveKeyProvider Usage**

```typescript
import { DeriveKeyProvider } from "@elizaos/plugin-tee";

// Initialize the provider
const provider = new DeriveKeyProvider();

// Derive a raw key
try {
    const rawKey = await provider.rawDeriveKey(
        "/path/to/derive",
        "subject-identifier",
    );
    // rawKey is a DeriveKeyResponse that can be used for further processing
    // to get the uint8Array do the following
    const rawKeyArray = rawKey.asUint8Array();
} catch (error) {
    console.error("Raw key derivation failed:", error);
}

// Derive a Solana keypair (Ed25519)
try {
    const solanaKeypair = await provider.deriveEd25519Keypair(
        "/path/to/derive",
        "subject-identifier",
    );
    // solanaKeypair can now be used for Solana operations
} catch (error) {
    console.error("Solana key derivation failed:", error);
}

// Derive an Ethereum keypair (ECDSA)
try {
    const evmKeypair = await provider.deriveEcdsaKeypair(
        "/path/to/derive",
        "subject-identifier",
    );
    // evmKeypair can now be used for Ethereum operations
} catch (error) {
    console.error("EVM key derivation failed:", error);
}
```

**RemoteAttestationProvider Usage**

```typescript
import { RemoteAttestationProvider } from "@elizaos/plugin-tee";
// Initialize the provider
const provider = new RemoteAttestationProvider();
// Generate Remote Attestation
try {
    const attestation = await provider.generateAttestation("your-report-data");
    console.log("Attestation:", attestation);
} catch (error) {
    console.error("Failed to generate attestation:", error);
}
```

**Configuration**

To get a TEE simulator for local testing, use the following commands:

```bash
docker pull phalanetwork/tappd-simulator:latest
# by default the simulator is available in localhost:8090
docker run --rm -p 8090:8090 phalanetwork/tappd-simulator:latest
```

When using the provider through the runtime environment, ensure the following settings are configured:

```env
 # Optional, for simulator purposes if testing on mac or windows. Leave empty for Linux x86 machines.
DSTACK_SIMULATOR_ENDPOINT="http://host.docker.internal:8090"
WALLET_SECRET_SALT=your-secret-salt // Required to single agent deployments
```

---

#### 9. Webhook Plugin (`@eliza/plugin-coinbase-webhooks`)

Manages webhooks using the Coinbase SDK, allowing for the creation and management of webhooks to listen for specific events on the Coinbase platform.

**Actions:**

- `CREATE_WEBHOOK` - Create a new webhook to listen for specific events.
    - **Inputs**:
        - `networkId` (string): The network ID where the webhook should listen for events.
        - `eventType` (string): The type of event to listen for (e.g., transfers).
        - `eventFilters` (object, optional): Additional filters for the event.
        - `eventTypeFilter` (string, optional): Specific event type filter.
    - **Outputs**: Confirmation message with webhook details.
    - **Example**:
        ```json
        {
            "networkId": "base",
            "eventType": "transfers",
            "notificationUri": "https://your-notification-uri.com"
        }
        ```

**Providers:**

- `webhookProvider` - Retrieves a list of all configured webhooks.
    - **Outputs**: A list of webhooks with details such as ID, URL, event type, and status.

**Description:**

The Webhook Plugin enables Eliza to interact with the Coinbase SDK to create and manage webhooks. This allows for real-time event handling and notifications based on specific criteria set by the user.

**Usage Instructions:**

1. **Configure the Plugin**
   Add the plugin to your character’s configuration:

    ```typescript
    import { webhookPlugin } from "@eliza/plugin-coinbase-webhooks";

    const character = {
        plugins: [webhookPlugin],
    };
    ```

2. **Ensure Secure Configuration**
   Set the following environment variables or runtime settings to ensure the plugin functions securely:

    - `COINBASE_API_KEY`: API key for Coinbase SDK.
    - `COINBASE_PRIVATE_KEY`: Private key for secure transactions.
    - `COINBASE_NOTIFICATION_URI`: URI where notifications should be sent.

**Example Call**

To create a webhook:

```typescript
const response = await runtime.triggerAction("CREATE_WEBHOOK", {
    networkId: "base",
    eventType: "transfers",
    notificationUri: "https://your-notification-uri.com",
});
console.log("Webhook creation response:", response);
```

**Best Practices:**

- **Secure Secrets Storage**: Ensure `COINBASE_API_KEY`, `COINBASE_PRIVATE_KEY`, and `COINBASE_NOTIFICATION_URI` are stored securely in `runtime.character.settings.secrets` or environment variables.
- **Validation**: Always validate input parameters to ensure compliance with expected formats and supported networks.
- **Error Handling**: Monitor logs for errors during webhook creation and adjust retry logic as needed.

### 10. Fuel Plugin (`@elizaos/plugin-fuel`)

The Fuel plugin provides an interface to the Fuel Ignition blockchain.

**Actions:**

1. `TRANSFER_FUEL_ETH` - Transfer ETH to a given Fuel address. - **Inputs**: - `toAddress` (string): The Fuel address to transfer ETH to. - `amount` (string): The amount of ETH to transfer. - **Outputs**: Confirmation message with transaction details. - **Example**:
   ```json
   {
    "toAddress": "0x8F8afB12402C9a4bD9678Bec363E51360142f8443FB171655eEd55dB298828D1",
    "amount": "0.00001"
   }
   ```
   **Setup and Configuration:**

1. **Configure the Plugin**
   Add the plugin to your character's configuration:

    ```typescript
    import { fuelPlugin } from "@eliza/plugin-fuel";

    const character = {
        plugins: [fuelPlugin],
    };
    ```

1. **Required Configurations**
   Set the following environment variables or runtime settings:

    - `FUEL_WALLET_PRIVATE_KEY`: Private key for secure transactions

### Writing Custom Plugins

Create a new plugin by implementing the Plugin interface:

```typescript
import { Plugin, Action, Evaluator, Provider } from "@elizaos/core";

const myCustomPlugin: Plugin = {
    name: "my-custom-plugin",
    description: "Adds custom functionality",
    actions: [
        /* custom actions */
    ],
    evaluators: [
        /* custom evaluators */
    ],
    providers: [
        /* custom providers */
    ],
    services: [
        /* custom services */
    ],
};
```

## Best Practices

1. **Modularity**: Keep plugins focused on specific functionality
2. **Dependencies**: Clearly document any external dependencies
3. **Error Handling**: Implement robust error handling
4. **Documentation**: Provide clear documentation for actions and evaluators
5. **Testing**: Include tests for plugin functionality

## Plugin Development Guidelines

### Action Development

- Implement the `Action` interface
- Provide clear validation logic
- Include usage examples
- Handle errors gracefully

### Evaluator Development

- Implement the `Evaluator` interface
- Define clear evaluation criteria
- Include validation logic
- Document evaluation metrics

### Provider Development

- Implement the `Provider` interface
- Define context generation logic
- Handle state management
- Document provider capabilities

## Common Issues & Solutions

### Plugin Loading Issues

```typescript
// Check if plugins are loaded correctly
if (character.plugins) {
    console.log("Plugins are: ", character.plugins);
    const importedPlugins = await Promise.all(
        character.plugins.map(async (plugin) => {
            const importedPlugin = await import(plugin);
            return importedPlugin;
        }),
    );
    character.plugins = importedPlugins;
}
```

### Service Registration

```typescript
// Proper service registration
registerService(service: Service): void {
    const serviceType = (service as typeof Service).serviceType;
    if (this.services.has(serviceType)) {
        console.warn(`Service ${serviceType} is already registered`);
        return;
    }
    this.services.set(serviceType, service);
}
```

## Future Extensions

The plugin system is designed to be extensible. Future additions may include:

- Database adapters
- Authentication providers
- Custom model providers
- External API integrations
- Workflow automation
- Custom UI components

## Contributing

To contribute a new plugin:

1. Follow the plugin structure guidelines
2. Include comprehensive documentation
3. Add tests for all functionality
4. Submit a pull request
5. Update the plugin registry

For detailed API documentation and examples, see the [API Reference](/api).
