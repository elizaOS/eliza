# `ai16z/plugin-thirdweb`

This plugin provides access to thirdweb's Nebula AI interface: [https://portal.thirdweb.com/nebula](https://portal.thirdweb.com/nebula).

## Configuration

### Default Setup

By default, \*_thirdweb plugin_ is enabled. To use it, simply add your secret key to the `.env` file:

```env
THIRDWEB_SECRET_KEY=your-thirdweb-secret-key-here
```

---

## Actions

### Chat

Interact with the thirdweb Nebula natural language interface to perform any of the following:

- Analyze any smart contract's functionality and features
- Explain contract interfaces and supported standards
- Read contract data and state
- Help you understand function behaviors and parameters
- Decode complex contract interactions
- Retrieve detailed contract metadata and source code analysis
- Provide real-time network status and gas prices
- Explain block and transaction details
- Help you understand blockchain network specifications
- Offer insights about different blockchain networks
- Track transaction status and history
- Access detailed chain metadata including RPC endpoints
- Look up token information across different networks
- Track token prices and market data
- Explain token standards and implementations
- Help you understand token bridges and cross-chain aspects
- Monitor trading pairs and liquidity
- Fetch token metadata and current exchange rates
- Retrieve detailed transaction information using transaction hashes
- Provide wallet balance and transaction history

**Example usage:**

```env
What is the ETH balance for 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045
```

```env
What is the total NFT supply for 0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D?
```

```env
Does 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 hold USDC on Base?
```

```env
What is the address of USDC on Ethereum?
```

---
