# `@elizaos/plugin-arthera`

This plugin provides actions and providers for interacting with Arthera.

---

## Configuration

### Default Setup

By default, **Arthera** is enabled. To use it, simply add your private key to the `.env` file:

```env
ARTHERA_PRIVATE_KEY=your-private-key-here
```

### Custom RPC URLs

By default, the RPC URL is inferred from the `viem/chains` config. To use a custom RPC URL for a specific chain, add the following to your `.env` file:

```env
ETHEREUM_PROVIDER_<CHAIN_NAME>=https://your-custom-rpc-url
```

**Example usage:**

```env
ETHEREUM_PROVIDER_ARTHERA=https://rpc.arthera.net
```

## Provider

The **Wallet Provider** initializes with Arthera. It:

- Provides the **context** of the currently connected address and its balance.
- Creates **Public** and **Wallet clients** to interact with the supported chain.

---

## Actions

### Transfer

Transfer tokens from one address to another on Arthera. Just specify the:

- **Amount**
- **Chain**
- **Recipient Address**

**Example usage:**

```bash
Transfer 1 AA to 0xRecipient on arthera.
```

---

## Contribution

The plugin contains tests. Whether you're using **TDD** or not, please make sure to run the tests before submitting a PR.

### Running Tests

Navigate to the `plugin-arthera` directory and run:

```bash
pnpm test
```
