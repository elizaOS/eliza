import { Service, ServiceType, IAgentRuntime } from "@elizaos/core";
import { Arbitrage } from "../core/Arbitrage";
import { WebSocket } from 'ws';
import { CrossedMarketDetails, MarketsByToken } from "../type";
import { WebSocketProvider } from "@ethersproject/providers";
import { Wallet } from "@ethersproject/wallet";
import { FlashbotsBundleProvider } from "@flashbots/ethers-provider-bundle";
import { Contract } from "@ethersproject/contracts";

// Declare the ARBITRAGE service type
declare module "@elizaos/core" {
    interface ServiceTypeMap {
        arbitrage: Service & ArbitrageService;
    }

    export enum ServiceType {
        ARBITRAGE = "arbitrage"
    }
}

export class ArbitrageService extends Service {
    private arbitrage: Arbitrage | null = null;
    private wsConnection: WebSocket | null = null;
    private marketsByToken = {};
    private currentBlock = 0;
    private runtime!: IAgentRuntime;

    static get serviceType(): ServiceType {
        return ServiceType.ARBITRAGE;
    }

    get serviceType(): ServiceType {
        return ServiceType.ARBITRAGE;
    }

    // Remove unnecessary constructor
    // constructor() {
    //     super();
    // }

    async initialize(runtime: IAgentRuntime): Promise<void> {
        this.runtime = runtime;

        // Get WebSocket URL with multiple fallback options
        let wsUrl = runtime.getSetting("ARBITRAGE_ETHEREUM_WS_URL")

        let rpcUrl = runtime.getSetting("ARBITRAGE_EVM_PROVIDER_URL") 
                    

        // Debug logging
        console.log('ArbitrageService initialize - URLs:', {
            wsUrl,
            rpcUrl
        });

        if (!wsUrl && !rpcUrl) {
            throw new Error("Missing both ARBITRAGE_ETHEREUM_WS_URL and ARBITRAGE_EVM_PROVIDER_URL envs");
        }

        // If we only have RPC URL, derive WS URL
        if (!wsUrl && rpcUrl) {
            wsUrl = rpcUrl.replace('https://', 'wss://');
            console.log('Using derived WebSocket URL:', wsUrl);
        }

        if (!wsUrl) {
            throw new Error("No WebSocket URL available after all fallbacks");
        }

        // Initialize wallet and providers
        const walletKey = runtime.getSetting("ARBITRAGE_EVM_PRIVATE_KEY") 
        if (!walletKey) throw new Error("Missing ARBITRAGE_EVM_PRIVATE_KEY env");

        // Initialize provider
        console.log('Initializing WebSocketProvider with URL:', wsUrl);
        const provider = new WebSocketProvider(wsUrl as string);
        const wallet = new Wallet(walletKey, provider);

        // Initialize Flashbots provider
        const flashbotsKey = runtime.getSetting("FLASHBOTS_RELAY_SIGNING_KEY") 
        if (!flashbotsKey) throw new Error("Missing FLASHBOTS_RELAY_SIGNING_KEY env");

        const flashbotsProvider = await FlashbotsBundleProvider.create(
            provider,
            wallet,
            flashbotsKey
        );

        // Initialize bundle executor contract
        const bundleExecutorAddress = runtime.getSetting("BUNDLE_EXECUTOR_ADDRESS");
        if (!bundleExecutorAddress) throw new Error("Missing BUNDLE_EXECUTOR_ADDRESS env");

        // Create Contract instance
        const bundleExecutorContract = new Contract(
            bundleExecutorAddress,
            [
                'function execute(bytes[] calldata calls) external payable',
                'function executeWithToken(bytes[] calldata calls, address tokenAddress, uint256 tokenAmount) external payable'
            ],
            wallet
        );

        // Initialize Arbitrage instance with Contract instance
        this.arbitrage = new Arbitrage(
            wallet,
            flashbotsProvider,
            bundleExecutorContract
        );

        // Setup WebSocket connection
        console.log('Setting up WebSocket connection to:', wsUrl);
        this.wsConnection = new WebSocket(wsUrl);
        this.setupWebSocketHandlers();
    }

    private setupWebSocketHandlers(): void {
        if (!this.wsConnection) return;

        this.wsConnection.on('open', () => {
            console.log('WebSocket connection established');
            // Subscribe to new blocks
            this.wsConnection?.send(JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'eth_subscribe',
                params: ['newHeads']
            }));
        });

        this.wsConnection.on('message', async (data: string) => {
            const message = JSON.parse(data);
            if (message.params?.result?.number) {
                this.currentBlock = Number.parseInt(message.params.result.number, 16);
            }
        });

        this.wsConnection.on('error', (error) => {
            console.error('WebSocket error:', error);
        });

        this.wsConnection.on('close', () => {
            console.log('WebSocket connection closed');
            // Attempt to reconnect after a delay
            setTimeout(() => this.initialize(this.runtime), 5000);
        });
    }

    async evaluateMarkets(): Promise<CrossedMarketDetails[]> {
        if (!this.arbitrage) throw new Error("ArbitrageService not initialized");
        return this.arbitrage.evaluateMarkets(this.marketsByToken);
    }

    async executeArbitrage(markets: CrossedMarketDetails[]): Promise<void> {
        if (!this.arbitrage) throw new Error("ArbitrageService not initialized");
        const maxAttempts = 10;
        return this.arbitrage.takeCrossedMarkets(markets, this.currentBlock, maxAttempts);
    }

    async stop(): Promise<void> {
        if (this.wsConnection) {
            this.wsConnection.close();
            this.wsConnection = null;
        }
    }
}