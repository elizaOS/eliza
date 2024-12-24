export const chargeTemplate = `
Extract the following details to create a Coinbase charge:
- **price** (number): The amount for the charge (e.g., 100.00).
- **currency** (string): The 3-letter ISO 4217 currency code (e.g., USD, EUR).
- **type** (string): The pricing type for the charge (e.g., fixed_price, dynamic_price). Assume price type is fixed unless otherwise stated
- **name** (string): A non-empty name for the charge (e.g., "The Human Fund").
- **description** (string): A non-empty description of the charge (e.g., "Money For People").

Provide the values in the following JSON format:

\`\`\`json
{
    "price": <number>,
    "currency": "<currency>",
    "type": "<type>",
    "name": "<name>",
    "description": "<description>"
}
\`\`\`

Here are the recent user messages for context:
{{recentMessages}}
`;

export const getChargeTemplate = `
Extract the details for a Coinbase charge using the provided charge ID:
- **charge_id** (string): The unique identifier of the charge (e.g., "2b364ef7-ad60-4fcd-958b-e550a3c47dc6").

Provide the charge details in the following JSON format after retrieving the charge details:

\`\`\`json
{
    "charge_id": "<charge_id>",
    "price": <number>,
    "currency": "<currency>",
    "type": "<type>",
    "name": "<name>",
    "description": "<description>",
    "status": "<status>",
    "created_at": "<ISO8601 timestamp>",
    "expires_at": "<ISO8601 timestamp>"
}
\`\`\`

Here are the recent user messages for context:
{{recentMessages}}
`;

export const transferTemplate = `
Extract the following details for processing a mass payout using the Coinbase SDK:
- **receivingAddresses** (array): A list of wallet addresses receiving the funds.
- **transferAmount** (number): The amount to transfer to each address.
- **assetId** (string): The asset ID to transfer (e.g., ETH, BTC).
- **network** (string): The blockchain network to use. Allowed values are:
    static networks: {
        readonly BaseSepolia: "base-sepolia";
        readonly BaseMainnet: "base-mainnet";
        readonly EthereumHolesky: "ethereum-holesky";
        readonly EthereumMainnet: "ethereum-mainnet";
        readonly PolygonMainnet: "polygon-mainnet";
        readonly SolanaDevnet: "solana-devnet";
        readonly SolanaMainnet: "solana-mainnet";
        readonly ArbitrumMainnet: "arbitrum-mainnet";
    };

Provide the details in the following JSON format:

\`\`\`json
{
    "receivingAddresses": ["<receiving_address_1>", "<receiving_address_2>"],
    "transferAmount": <amount>,
    "assetId": "<asset_id>",
    "network": "<network>"
}
\`\`\`

Here are the recent user messages for context:
{{recentMessages}}
`;

export const tradeTemplate = `
Extract the following details for processing a trade using the Coinbase SDK:
- **network** (string): The blockchain network to use (e.g., base, sol, eth, arb, pol).
- **amount** (number): The amount to trade.
- **sourceAsset** (string): The asset ID to trade from (must be one of: ETH, SOL, USDC, WETH, GWEI, LAMPORT).
- **targetAsset** (string): The asset ID to trade to (must be one of: ETH, SOL, USDC, WETH, GWEI, LAMPORT).
- **side** (string): The side of the trade (must be either "BUY" or "SELL").

Ensure that:
1. **network** is one of the supported networks: "base", "sol", "eth", "arb", or "pol".
2. **sourceAsset** and **targetAsset** are valid assets from the provided list.
3. **amount** is a positive number.
4. **side** is either "BUY" or "SELL".

Provide the details in the following JSON format:

\`\`\`json
{
    "network": "<network>",
    "amount": <amount>,
    "sourceAsset": "<source_asset_id>",
    "targetAsset": "<target_asset_id>",
    "side": "<side>"
}
\`\`\`

Here are the recent user messages for context:
{{recentMessages}}
`;

export const advancedTradeTemplate = `
Extract the following details for processing an advanced trade using the Coinbase Advanced Trading API:
- **productId** (string): The trading pair ID (e.g., "BTC-USD", "ETH-USD", "SOL-USD")
- **side** (string): The side of the trade (must be either "BUY" or "SELL")
- **amount** (number): The amount to trade
- **orderType** (string): The type of order (must be either "MARKET" or "LIMIT")
- **limitPrice** (number, optional): The limit price for limit orders

Ensure that:
1. **productId** follows the format "ASSET-USD" (e.g., "BTC-USD")
2. **side** is either "BUY" or "SELL"
3. **amount** is a positive number
4. **orderType** is either "MARKET" or "LIMIT"
5. **limitPrice** is provided when orderType is "LIMIT"

Provide the details in the following JSON format:

\`\`\`json
{
    "productId": "<product_id>",
    "side": "<side>",
    "amount": <amount>,
    "orderType": "<order_type>",
    "limitPrice": <limit_price>
}
\`\`\`

Here are the recent user messages for context:
{{recentMessages}}
`;


export const tokenContractTemplate = `
Extract the following details for deploying a token contract using the Coinbase SDK:
- **contractType** (string): The type of token contract to deploy (ERC20, ERC721, or ERC1155)
- **name** (string): The name of the token
- **symbol** (string): The symbol of the token
- **network** (string): The blockchain network to deploy on (e.g., base, eth, arb, pol)
- **baseURI** (string, optional): The base URI for token metadata (required for ERC721 and ERC1155)
- **totalSupply** (number, optional): The total supply of tokens (only for ERC20)

Provide the details in the following JSON format:

\`\`\`json
{
    "contractType": "<contract_type>",
    "name": "<token_name>",
    "symbol": "<token_symbol>",
    "network": "<network>",
    "baseURI": "<base_uri>",
    "totalSupply": <total_supply>
}
\`\`\`

Here are the recent user messages for context:
{{recentMessages}}
`;

// Add to templates.ts
export const contractInvocationTemplate = `
Extract the following details for invoking a smart contract using the Coinbase SDK:
- **contractAddress** (string): The address of the contract to invoke
- **method** (string): The method to invoke on the contract
- **abi** (array): The ABI of the contract
- **args** (object, optional): The arguments to pass to the contract method
- **amount** (string, optional): The amount of the asset to send (as string to handle large numbers)
- **assetId** (string, required): The ID of the asset to send (e.g., 'USDC')
- **networkId** (string, required): The network ID to use in format "chain-network".
 static networks: {
        readonly BaseSepolia: "base-sepolia";
        readonly BaseMainnet: "base-mainnet";
        readonly EthereumHolesky: "ethereum-holesky";
        readonly EthereumMainnet: "ethereum-mainnet";
        readonly PolygonMainnet: "polygon-mainnet";
        readonly SolanaDevnet: "solana-devnet";
        readonly SolanaMainnet: "solana-mainnet";
        readonly ArbitrumMainnet: "arbitrum-mainnet";
    };

Provide the details in the following JSON format:

\`\`\`json
{
    "contractAddress": "<contract_address>",
    "method": "<method_name>",
    "abi": [<contract_abi>],
    "args": {
        "<arg_name>": "<arg_value>"
    },
    "amount": "<amount_as_string>",
    "assetId": "<asset_id>",
    "networkId": "<network_id>"
}
\`\`\`

Example for invoking a transfer method on the USDC contract:

\`\`\`json
{
    "contractAddress": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    "method": "transfer",
    "abi": [
        {
            "constant": false,
            "inputs": [
                {
                    "name": "to",
                    "type": "address"
                },
                {
                    "name": "amount",
                    "type": "uint256"
                }
            ],
            "name": "transfer",
            "outputs": [
                {
                    "name": "",
                    "type": "bool"
                }
            ],
            "payable": false,
            "stateMutability": "nonpayable",
            "type": "function"
        }
    ],
    "args": {
        "to": "0xbcF7C64B880FA89a015970dC104E848d485f99A3",
        "amount": "1000000" // 1 USDC (6 decimals)
    },
    "networkId": "ethereum-mainnet",
    "assetId": "USDC"
}
\`\`\`

Here are the recent user messages for context:
{{recentMessages}}
`;

export const webhookTemplate = `
Extract the following details for creating a webhook:
- **networkId** (string): The network ID for which the webhook is created.
Allowed values are:
    static networks: {
        readonly BaseSepolia: "base-sepolia";
        readonly BaseMainnet: "base-mainnet";
        readonly EthereumHolesky: "ethereum-holesky";
        readonly EthereumMainnet: "ethereum-mainnet";
        readonly PolygonMainnet: "polygon-mainnet";
        readonly SolanaDevnet: "solana-devnet";
        readonly SolanaMainnet: "solana-mainnet";
        readonly ArbitrumMainnet: "arbitrum-mainnet";
    };
- **eventType** (string): The type of event for the webhook.
export declare const WebhookEventType: {
    readonly Unspecified: "unspecified";
    readonly Erc20Transfer: "erc20_transfer";
    readonly Erc721Transfer: "erc721_transfer";
    readonly WalletActivity: "wallet_activity";
};
- **eventTypeFilter** (string, optional): Filter for wallet activity event type.
export interface WebhookEventTypeFilter {
    /**
     * A list of wallet addresses to filter on.
     * @type {Array<string>}
     * @memberof WebhookWalletActivityFilter
     */
    'addresses'?: Array<string>;
    /**
     * The ID of the wallet that owns the webhook.
     * @type {string}
     * @memberof WebhookWalletActivityFilter
     */
    'wallet_id'?: string;
}
- **eventFilters** (array, optional): Filters applied to the events that determine which specific events trigger the webhook.
export interface Array<WebhookEventFilter> {
    /**
     * The onchain contract address of the token for which the events should be tracked.
     * @type {string}
     * @memberof WebhookEventFilter
     */
    'contract_address'?: string;
    /**
     * The onchain address of the sender. Set this filter to track all transfer events originating from your address.
     * @type {string}
     * @memberof WebhookEventFilter
     */
    'from_address'?: string;
    /**
     * The onchain address of the receiver. Set this filter to track all transfer events sent to your address.
     * @type {string}
     * @memberof WebhookEventFilter
     */
    'to_address'?: string;
}
Provide the details in the following JSON format:
\`\`\`json
{
    "networkId": "<networkId>",
    "eventType": "<eventType>",
    "eventTypeFilter": "<eventTypeFilter>",
    "eventFilters": [<eventFilter1>, <eventFilter2>]
}
\`\`\`



Example for creating a webhook on the Sepolia testnet for ERC20 transfers originating from a specific wallet 0x1234567890123456789012345678901234567890 on transfers from 0xbcF7C64B880FA89a015970dC104E848d485f99A3

\`\`\`javascript

    networkId: 'base-sepolia', // Listening on sepolia testnet transactions
    eventType: 'erc20_transfer',
    eventTypeFilter: {
      addresses: ['0x1234567890123456789012345678901234567890']
    },
    eventFilters: [{
      from_address: '0xbcF7C64B880FA89a015970dC104E848d485f99A3',
    }],
});
\`\`\`

Here are the recent user messages for context:
{{recentMessages}}
`;

export const readContractTemplate = `
Extract the following details for reading from a smart contract using the Coinbase SDK:
- **contractAddress** (string): The address of the contract to read from (must start with 0x)
- **method** (string): The view/pure method to call on the contract
- **networkId** (string): The network ID based on networks configured in Coinbase SDK
Allowed values are:
    static networks: {
        readonly BaseSepolia: "base-sepolia";
        readonly BaseMainnet: "base-mainnet";
        readonly EthereumHolesky: "ethereum-holesky";
        readonly EthereumMainnet: "ethereum-mainnet";
        readonly PolygonMainnet: "polygon-mainnet";
        readonly SolanaDevnet: "solana-devnet";
        readonly SolanaMainnet: "solana-mainnet";
        readonly ArbitrumMainnet: "arbitrum-mainnet";
    };
- **args** (object): The arguments to pass to the contract method
- **abi** (array, optional): The contract ABI if needed for complex interactions

Provide the details in the following JSON format:

\`\`\`json
{
    "contractAddress": "<0x-prefixed-address>",
    "method": "<method_name>",
    "networkId": "<network_id>",
    "args": {
        "<arg_name>": "<arg_value>"
    },
    "abi": [
        // Optional ABI array
    ]
}
\`\`\`

Example for reading the balance of an ERC20 token:

\`\`\`json
{
    "contractAddress": "0x37f2131ebbc8f97717edc3456879ef56b9f4b97b",
    "method": "balanceOf",
    "networkId": "eth-mainnet",
    "args": {
        "account": "0xbcF7C64B880FA89a015970dC104E848d485f99A3"
    }
}
\`\`\`

Here are the recent user messages for context:
{{recentMessages}}
`;

export const bridgeTemplate = `
Extract the following details for bridging tokens between networks using Circle's CCTP:
- **sourceWalletId** (string): ID of the source wallet on Base
- **destinationWalletId** (string): ID of the destination wallet on Arbitrum
- **amount** (string): Amount to bridge (in base units, e.g., 1000000 for 1 USDC)
- **token** (string): Token symbol to bridge (currently supports USDC)

Provide the details in the following JSON format:

\`\`\`json
{
    "sourceWalletId": "<source_wallet_id>",
    "destinationWalletId": "<destination_wallet_id>",
    "amount": "<amount_in_base_units>",
    "token": "<token_symbol>"
}
\`\`\`

Example for bridging 1 USDC from Base to Arbitrum:

\`\`\`json
{
    "sourceWalletId": "base-wallet-123",
    "destinationWalletId": "arbitrum-wallet-456",
    "amount": "1000000",
    "token": "USDC"
}
\`\`\`

Here are the recent user messages for context:
{{recentMessages}}
`;