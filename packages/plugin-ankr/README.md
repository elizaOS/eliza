
## Ankr Plugin Guide
![alt text](assets/ankr.jpg)

<div align="center">
  <h3>🔗 Blockchain Data Query Interface</h3>
</div>

### Available Actions

The Ankr plugin provides comprehensive blockchain data querying capabilities through natural language prompts. Below are the supported actions and their usage:

#### 1. Blockchain Information
```bash
# Get blockchain stats
Show me stats for [chain]eth[/chain]

# Get top currencies
Show me the top currencies on [chain]eth[/chain]
```

#### 2. Wallet & Balance Queries
```bash
# Check wallet balance
Show me the balance for wallet [wallet]0x6B0031518934952C485d5a7E76f1729B50e67486[/wallet] on [chain]eth[/chain]

# View wallet interactions
Show me interactions for the wallet [wallet]0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45[/wallet]
```

#### 3. NFT Operations
```bash
# Get NFT holders
Show me holders of NFT contract [contract]0x34d85c9cdeb23fa97cb08333b511ac86e1c4e258[/contract] token [token]112234[/token] on [chain]eth[/chain]

# Get NFT metadata
Show me the metadata for NFT [token]1234[/token] at contract [contract]0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d[/contract] [chain]eth[/chain]

# List NFTs by owner
Show me all NFTs owned by wallet [wallet]0x1234567890123456789012345678901234567890[/wallet] on [chain]eth[/chain]

# View NFT transfers
Show me NFT transfers for contract [contract]0xd8da6bf26964af9d7eed9e03e53415d37aa96045[/contract] [chain]eth[/chain] [fromtimestamp]1655197483[/fromtimestamp][totimestamp]1671974699[/totimestamp]
```

#### 4. Token Operations
```bash
# Get token holders
Show me holders for contract [contract]0xf307910A4c7bbc79691fD374889b36d8531B08e3[/contract] on [chain]bsc[/chain]

# Get token holder count
How many holders does [contract]0xdAC17F958D2ee523a2206206994597C13D831ec7[/contract] have? [chain]eth[/chain]

# Check token price
What's the current price of [contract]0x8290333cef9e6d528dd5618fb97a76f268f3edd4[/contract] token [chain]eth[/chain]

# View token transfers
Show me recent contract [contract]0xd8da6bf26964af9d7eed9e03e53415d37aa96045[/contract] transfers [chain]eth[/chain] from [fromtimestamp]1655197483[/fromtimestamp] to [totimestamp]1656061483[/totimestamp]
```

#### 5. Transaction Queries
```bash
# Get transactions by address
Show me the latest transactions for address [contract]0xd8da6bf26964af9d7eed9e03e53415d37aa96045[/contract] [chain]eth[/chain]

# Get transaction details
Show me details for transaction [txHash]0x748eeb4a15ba05736a9397a07ca86f0184c0c1eca53fa901b28a412d1a3f211f[/txHash] [chain]eth[/chain]
```

### Tag Reference

| Tag | Description | Example |
|-----|-------------|---------|
| `[chain]` | Blockchain identifier | eth, bsc |
| `[wallet]` | Wallet address | 0x1234... |
| `[contract]` | Contract address | 0xabcd... |
| `[token]` | Token ID | 1234 |
| `[txHash]` | Transaction hash | 0x748e... |
| `[fromtimestamp]` | Start timestamp | 1655197483 |
| `[totimestamp]` | End timestamp | 1656061483 |

### Important Notes

1. All addresses must be valid blockchain addresses (0x format)
2. Timestamps must be in Unix timestamp format
3. Chain names should be lowercase (eth, bsc, etc.)
4. Transaction hashes must be complete and valid
5. Include all required tags for each action typ