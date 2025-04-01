import { defineChain } from 'viem';

export const customChain = defineChain({
    id: 12345, // Your custom chain ID
    name: 'My Custom Chain',
    nativeCurrency: {
        name: 'MyToken',
        symbol: 'MYT',
        decimals: 18,
    },
    rpcUrls: {
        default: { http: ['https://rpc.mycustomchain.com'] },
        public: { http: ['https://rpc.mycustomchain.com'] },
    },
    blockExplorers: {
        default: { name: 'MyChain Explorer', url: 'https://explorer.mycustomchain.com' },
    },
    testnet: false, // Set to `true` if it's a testnet
});
