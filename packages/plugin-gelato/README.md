# plugin-gelato

A powerful plugin to interact with smart contracts using Gelato Relay, supporting both **ERC2771 (meta transactions)** and **non-ERC2771 calls** on any EVM-compatible blockchain.

---

## Features

-   **Sponsored Calls**: Interact with contracts without needing gas on the user's side.
-   **ERC2771 Support**: Execute meta-transactions via Gelato's `sponsoredCallERC2771`.
-   **Customizable**: Easily configure chains, contracts, and user-specific settings.

---

## Prerequisites

-   pnpm
-   A Gelato Relay API key

---

## Installation

```
pnpm install elizaos/plugin-gelato
```

---

## Configuration

Fill out the `.env` file in the project root with the following variables:

```
GELATO_RELAY_API_KEY=<Your Gelato Relay API Key>
EVM_PROVIDER_URL=<Your EVM provider URL (e.g., Alchemy or Infura endpoint)>
EVM_PRIVATE_KEY=<Your wallet's private key>
```

---

## Usage

### For Non-ERC2771 (Standard Sponsored Call)

```plaintext
Call increment() on 0x3890DB55ff538FBF281c9152820A4a748f5D6F21 contract:
- Function Name: increment
- Args: []
- Target: 0x3890DB55ff538FBF281c9152820A4a748f5D6F21
- Chain: arbitrumSepolia
- ABI: ["function increment()"]
```

### For ERC2771 (Meta-Transactions)

```plaintext
Call increment() on 0x00172f67db60E5fA346e599cdE675f0ca213b47b contract:
- Function Name: increment
- Args: []
- Target: 0x00172f67db60E5fA346e599cdE675f0ca213b47b
- Chain: arbitrumSepolia
- ABI: ["function increment()"]
- User: 0xYourAddressHere
```

### Example Output

For both scenarios, successful execution returns:

```plaintext
✅ Contract interaction successful!
- Function: increment
- Target: 0x<contract_address>
- Chain: arbitrumSepolia
- Task ID: <task_id>
- Track Status: [View Task](https://relay.gelato.digital/tasks/status/<task_id>)
```

---

## Development

### Code Structure

-   **`utils.ts`**:
    Contains functions for `sponsoredCall` and `sponsoredCallERC2771`.

-   **`schemas.ts`**:
    Defines Zod schemas to validate user input.

-   **`actions.ts`**:
    Contains the action logic, including parsing natural language input and invoking Gelato Relay.

### Testing

1. Update your `.env` file with valid keys.
2. Test both **ERC2771** and **non-ERC2771** prompts using the examples above.

---

## Troubleshooting

-   Ensure your `.env` file is properly configured.
-   Verify that your contract ABI, function name, and chain match the deployed contract details.
-   For ERC2771 calls, confirm the `User` address is correct and matches the expected `_msgSender` logic in the contract.

---

## License

This plugin is licensed under the MIT License. See the `LICENSE` file for details.

```

```
