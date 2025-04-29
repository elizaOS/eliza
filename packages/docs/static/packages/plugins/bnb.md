# @ai16z/plugin-bnb

## Purpose

This plugin enables interaction with the BNB Chain ecosystem, providing support for BNB Smart Chain, opBNB, and BNB Greenfield networks.

## Configuration

### Default Setup

By default, **plugin-bnb** is not enabled. To use it, add your private key and/or public key to the `.env` file. If private key is not provided, some actions will be disabled.

```env
BNB_PRIVATE_KEY=your-private-key-here
BNB_PUBLIC_KEY=your-public-key-here
```

### Custom RPC URLs

To use custom RPC URLs, add the following to your `.env` file:

```env
BSC_PROVIDER_URL=https://your-custom-bsc-rpc-url
OPBNB_PROVIDER_URL=https://your-custom-opbnb-rpc-url
```

## Integration

The **Wallet Provider** initializes with BSC as the default. It provides the context of the currently connected address and its balance, and creates Public and Wallet clients to interact with the supported chains.

## Example Usage

```bash
Get the USDC balance of 0x1234567890 on BSC.
Transfer 1 BNB to 0xRecipient on BSC.
Swap 1 BNB to USDC on BSC.
Bridge 1 BNB from BSC to opBNB.
Deposit 1 BNB to Lista Dao.
Get some testnet USDC from the faucet.
```

## Contribution

The plugin contains tests. Navigate to the `plugin-bnb` directory and run:

```bash
bun test
```
