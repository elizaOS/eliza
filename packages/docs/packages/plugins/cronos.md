# @elizaos/plugin-cronos

Cronos plugin for Eliza, extending the EVM plugin functionality.

## Supported Networks

### Mainnet
- Cronos Mainnet (Chain ID: 25)
  - RPC Endpoint: https://evm.cronos.org/
  - Explorer: https://explorer.cronos.org/
  - Native Token: CRO

### Testnet
- Cronos Testnet 3 (Chain ID: 338)
  - RPC Endpoint: https://evm-t3.cronos.org/
  - Explorer: https://cronos.org/explorer/testnet3
  - Native Token: TCRO

## Installation

```bash
pnpm add @elizaos/plugin-cronos
```

## Usage

### Basic Setup
```typescript
import { cronosPlugin } from "@elizaos/plugin-cronos";

// Use the plugin in your Eliza configuration
const config = {
    plugins: [cronosPlugin],
    // ... rest of your config
};
```

### Character Configuration Guide

Create a `your-character.character.json` file with the following structure:

```json
{
    "name": "YourCharacterName",
    "plugins": ["@elizaos/plugin-cronos"],
    "clients": ["telegram"],
    "modelProvider": "openai",
    "settings": {
        "secrets": {},
        "chains": {
            "evm": ["cronos", "cronosTestnet"]
        }
    },
    "system": "Primary function is to execute token transfers and check balances on Cronos chain.",
    "actions": {
        "SEND_TOKEN": {
            "enabled": true,
            "priority": 1,
            "force": true,
            "schema": {
                "type": "object",
                "properties": {
                    "fromChain": {
                        "type": "string",
                        "description": "The chain to execute the transfer on",
                        "enum": ["cronos", "cronosTestnet"]
                    },
                    "toAddress": {
                        "type": "string",
                        "description": "The recipient's wallet address",
                        "pattern": "^0x[a-fA-F0-9]{40}$"
                    },
                    "amount": {
                        "type": "string",
                        "description": "The amount of tokens to transfer",
                        "pattern": "^[0-9]*(\\.[0-9]+)?$"
                    }
                },
                "required": ["fromChain", "toAddress", "amount"]
            },
            "triggers": [
                "send * CRO to *",
                "transfer * CRO to *"
            ],
            "examples": [
                {
                    "input": "Send 0.1 CRO to 0x...",
                    "output": {
                        "fromChain": "cronos",
                        "toAddress": "0x...",
                        "amount": "0.1"
                    }
                }
            ]
        },
        "CHECK_BALANCE": {
            "enabled": true,
            "priority": 1,
            "force": true,
            "schema": {
                "type": "object",
                "properties": {
                    "chain": {
                        "type": "string",
                        "description": "The chain to check balance on",
                        "enum": ["cronos", "cronosTestnet"]
                    }
                },
                "required": ["chain"]
            },
            "triggers": [
                "check balance",
                "show balance",
                "what's my balance",
                "how much CRO do I have",
                "check balance on *",
                "show balance on *"
            ],
            "examples": [
                {
                    "input": "check balance",
                    "output": {
                        "chain": "cronos"
                    }
                },
                {
                    "input": "what's my balance on testnet",
                    "output": {
                        "chain": "cronosTestnet"
                    }
                }
            ]
        }
    },
    "messageExamples": [
        [
            {
                "user": "{{user1}}",
                "content": {
                    "text": "Send 100 CRO to 0x..."
                }
            },
            {
                "user": "YourCharacterName",
                "content": {
                    "text": "Processing token transfer...",
                    "action": "SEND_TOKEN"
                }
            }
        ],
        [
            {
                "user": "{{user1}}",
                "content": {
                    "text": "What's my balance?"
                }
            },
            {
                "user": "YourCharacterName",
                "content": {
                    "text": "Checking your balance...",
                    "action": "CHECK_BALANCE"
                }
            }
        ]
    ]
}
```

#### Key Configuration Fields:

1. **Basic Setup**
   - `name`: Your character's name
   - `plugins`: Include `@elizaos/plugin-cronos`
   - `clients`: Supported client platforms

2. **Chain Settings**
   - Configure both mainnet and testnet in `settings.chains.evm`
   - Available options: `"cronos"` (mainnet) and `"cronosTestnet"`

3. **Action Configuration**
   - `SEND_TOKEN`: Action for token transfers
   - `CHECK_BALANCE`: Action for checking wallet balance
   - `schema`: Defines the required parameters for each action
   - `triggers`: Phrases that activate the actions
   - `examples`: Sample inputs and outputs

4. **Message Examples**
   - Provide example interactions
   - Show how actions are triggered
   - Demonstrate expected responses

### Action Examples
```
// Send tokens on mainnet
"Send 0.1 CRO to 0x..." use mainnet

// Send tokens on testnet
"Send 0.1 TCRO to 0x..." use testnet

// Check balance on mainnet
"check balance"
"what's my balance"
"how much CRO do I have"

// Check balance on testnet
"check balance on testnet"
"what's my balance on testnet"
```

## Features

- All standard EVM functionality inherited from @elizaos/plugin-evm
- Preconfigured for both Cronos Mainnet and Testnet
- Native CRO/TCRO token support
- Automated token transfer actions
- Balance checking functionality
- Built-in chain configuration

## Environment Variables

Required environment variable for transactions:

```env
# Wallet private key (Required, must start with 0x)
CRONOS_PRIVATE_KEY=0x...
```

### Security Warnings ⚠️

- **NEVER** commit private keys to version control
- **NEVER** share private keys with anyone
- **ALWAYS** use environment variables or secure key management
- Use separate keys for mainnet and testnet
- Monitor your wallet for unauthorized transactions

### Setup

1. Create `.env` file:
```env
CRONOS_PRIVATE_KEY=0x...  # Mainnet
```

2. For testnet development, use `.env.local`:
```env
CRONOS_PRIVATE_KEY=0x...  # Testnet only
```

3. Add to `.gitignore`:
```
.env
.env.*
```

## License

MIT