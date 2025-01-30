import {
    Abi,
    Account,
    Address,
    Chain,
    createPublicClient,
    createWalletClient,
    WalletClient,
    formatUnits,
    http,
    HttpTransport,
    isAddress,
    PublicClient,
    type SendTransactionParameters,
    type Kzg,
    parseEther,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { normalize } from "viem/ens";
import {
    type ICacheManager,
    type IAgentRuntime,
    type Memory,
    type State,
    type Provider,
    elizaLogger,
} from "@elizaos/core";
import NodeCache from "node-cache";
import * as path from "path";
import rawAbi from "../abi/curves.json";
import formtTestnet from "../chains/form.testnet";
import form from "../chains/form";
import { CURVES_ADDRESSES, CurvesType } from "../utils/addresses";
import { Tx, ReadReq } from "../types";
import { ERC20 } from "../types/erc20";

const curvesAbi = rawAbi as unknown as Abi;

export class FormWalletClient {
    private cache: NodeCache;
    private cacheKey: string = "form/wallet";
    private chain: Chain;
    private CACHE_EXPIRY_SEC = 60;
    private client: WalletClient;
    private curves: {
        addresses: Record<CurvesType, Address>;
        abi: typeof curvesAbi;
    };

    constructor(
        accountOrPrivateKey: `0x${string}`,
        private cacheManager: ICacheManager,
        isTestnet: boolean = false
    ) {
        this.cache = new NodeCache({ stdTTL: this.CACHE_EXPIRY_SEC });
        this.chain = isTestnet ? formtTestnet : form;

        const account = privateKeyToAccount(accountOrPrivateKey);

        this.client = createWalletClient({
            account,
            chain: this.chain,
            transport: this.createHttpTransport(),
        });

        this.curves = {
            addresses: CURVES_ADDRESSES[this.chain.id],
            abi: curvesAbi,
        };
    }

    getCurvesAddress(formula: CurvesType): Address {
        const chainId = this.getChain().id;
        return CURVES_ADDRESSES[chainId][formula];
    }

    private createHttpTransport() {
        if (this.chain.rpcUrls.custom) {
            return http(this.chain.rpcUrls.custom.http[0]);
        }
        return http(this.chain.rpcUrls.default.http[0]);
    }

    async resolveAddress(address: string) {
        if (isAddress(address, { strict: false })) return address as Address;

        try {
            const resolvedAddress = (await this.getPublicClient().getEnsAddress(
                {
                    name: normalize(address),
                }
            )) as Address;
            if (!resolvedAddress) {
                throw new Error(
                    "[plugin-form] ENS name could not be resolved."
                );
            }
            return resolvedAddress as Address;
        } catch (error) {
            throw new Error(
                `[plugin-form] failed to resolve ENS name [${address}]: ${error}`
            );
        }
    }

    // Cache helpers
    private async readFromCache<T>(key: string): Promise<T | null> {
        return await this.cacheManager.get<T>(path.join(this.cacheKey, key));
    }

    private async writeToCache<T>(key: string, data: T): Promise<void> {
        await this.cacheManager.set(path.join(this.cacheKey, key), data, {
            expires: Date.now() + this.CACHE_EXPIRY_SEC * 1000,
        });
    }

    private async getCachedData<T>(key: string): Promise<T | null> {
        // Check in-memory cache first
        const cachedData = this.cache.get<T>(key);
        if (cachedData) {
            return cachedData;
        }

        // Check file-based cache
        const fileCachedData = await this.readFromCache<T>(key);
        if (fileCachedData) {
            // Populate in-memory cache
            this.cache.set(key, fileCachedData);
            return fileCachedData;
        }

        return null;
    }

    private async invalidateData(key: string) {
        // Invalidate in-memory cache
        this.cache.del(key);

        // Invalidate cache-managed entry
        await this.cacheManager.delete(key);
    }

    private async setCachedData<T>(cacheKey: string, data: T): Promise<void> {
        // Set in-memory cache
        this.cache.set(cacheKey, data);

        // Write to file-based cache
        await this.writeToCache(cacheKey, data);
    }

    getAccount(): Account {
        return this.client.account;
    }

    getAddress(): Address {
        return this.client.account?.address as Address;
    }

    getChain(): Chain {
        return this.chain;
    }

    getPublicClient(): PublicClient<HttpTransport, Chain, Account | undefined> {
        const transport = this.createHttpTransport();

        const publicClient = createPublicClient({
            chain: this.chain,
            transport,
        });
        return publicClient;
    }

    getWalletClient(): WalletClient {
        return this.client;
    }

    async getWalletBalance(): Promise<string | null> {
        const cacheKey = `${this.chain.id}_wallet_balance_${this.getAddress()}`;
        const cachedData = await this.getCachedData<string>(cacheKey);
        if (cachedData) {
            elizaLogger.log(
                "[plugin-form] returning cached wallet balance for chain: " +
                    this.chain.name
            );
            return cachedData;
        }

        try {
            const balance = await this.getPublicClient().getBalance({
                address: this.getAddress(),
            });
            const balanceFormatted = formatUnits(balance, 18);
            this.setCachedData<string>(cacheKey, balanceFormatted);
            elizaLogger.log(
                "[plugin-form] wallet balance cached for chain: ",
                this.chain
            );
            return balanceFormatted;
        } catch (error) {
            console.error("Error getting wallet balance:", error);
            return null;
        }
    }

    async read(request: ReadReq) {
        const { address, abi, functionName, args } = request;
        if (!abi)
            throw new Error(
                "[plugin-form] cannot execute read transaction without abi"
            );

        const result = await this.getPublicClient().readContract({
            address: await this.resolveAddress(address),
            abi,
            functionName,
            args,
        });

        return result;
    }

    async sendTransaction(transaction: Tx) {
        const { to, abi, functionName, args, value, options, data } =
            transaction;
        if (!this.getWalletClient().account)
            throw new Error("[plugin-form] no account connected");

        // Contract call with function name
        if (abi && !functionName) {
            throw new Error(
                "[plugin-form] function name is required for contract calls"
            );
        }

        const toAddress = await this.resolveAddress(to);

        // No abi: simple ETH transfer
        if (!abi) {
            const txParams: SendTransactionParameters = {
                to: toAddress,
                value,
                data,
                account: this.getWalletClient().account,
                chain: this.chain,
                // Add gas options if provided
                ...(options?.gasLimit && { gas: options.gasLimit }),
                kzg: {} as Kzg,
            };

            const txHash =
                await this.getWalletClient().sendTransaction(txParams);
            return this.waitForReceipt(txHash);
        }

        const { request } = await this.getPublicClient().simulateContract({
            account: this.getWalletClient().account,
            address: toAddress,
            abi: abi,
            functionName,
            args,
            chain: this.chain,
            value: value,
            // Add gas options if provided
            ...(options?.gasLimit && { gas: options.gasLimit }),
        });

        const txHash = await this.getWalletClient().writeContract(request);
        return this.waitForReceipt(txHash);
    }

    async signMessage(message: string | { raw: `0x${string}` }) {
        if (!this.getWalletClient().account) {
            throw new Error("[plugin-form] no account connected");
        }

        try {
            const signature = await this.getWalletClient().signMessage({
                message: typeof message === "string" ? message : message.raw,
                account: this.getWalletClient().account,
            });

            return { signature };
        } catch (error) {
            throw new Error(`[plugin-form] failed to sign message: ${error}`);
        }
    }

    private async waitForReceipt(txHash: `0x${string}`) {
        return await this.getPublicClient().waitForTransactionReceipt({
            hash: txHash,
        });
    }

    public async buyCurvesToken(curves: Address, subject: Address, amount = 1) {
        try {
            elizaLogger.info(
                `[plugin-form] initiating buy [curves: ${curves} | amount: ${amount}]`
            );
            const buyPrice = await this.getCurvesBuyPrice(
                curves,
                subject,
                amount
            );

            const tx = await this.sendTransaction({
                to: curves,
                abi: this.curves.abi,
                functionName: "buyCurvesToken",
                args: [subject, amount],
                value: buyPrice,
            });

            elizaLogger.info(
                `[plugin-form] buy successful [tx: ${tx.transactionHash}]`
            );

            // Invalidate curves balance as it has changed
            const balanceCacheKey = this.getCurvesBalanceCacheKey(
                curves,
                this.getAddress(),
                subject
            );
            this.invalidateData(balanceCacheKey);

            return tx;
        } catch (error) {
            elizaLogger.error(`[plugin-form] buy failed:`, error);
            throw error;
        }
    }

    public async sellCurvesToken(
        curves: Address,
        subject: Address,
        amount = 1
    ) {
        try {
            const result = await this.sendTransaction({
                to: curves,
                abi: this.curves.abi,
                functionName: "sellCurvesToken",
                args: [subject, amount],
            });

            // Invalidate curves balance as it has changed
            const balanceCacheKey = this.getCurvesBalanceCacheKey(
                curves,
                this.getAddress(),
                subject
            );
            this.invalidateData(balanceCacheKey);

            return result;
        } catch (error) {
            throw new Error(
                `[plugin-form] failed to sell curves token: ${error}`
            );
        }
    }

    public async withdrawCurves(curves: Address, subject: Address, amount = 1) {
        try {
            const result = await this.sendTransaction({
                to: curves,
                abi: this.curves.abi,
                functionName: "withdraw",
                args: [subject, amount],
            });

            // Invalidate curves balance as it has changed
            const balanceCacheKey = this.getCurvesBalanceCacheKey(
                curves,
                this.getAddress(),
                subject
            );
            this.invalidateData(balanceCacheKey);

            return result;
        } catch (error) {
            throw new Error(`[plugin-form] failed to withdraw: ${error}`);
        }
    }

    public async depositCurves(
        curves: Address,
        subject: Address,
        amount = BigInt("1000000000000000000")
    ) {
        try {
            const result = await this.sendTransaction({
                to: curves,
                abi: this.curves.abi,
                functionName: "deposit",
                args: [subject, amount],
            });

            // Invalidate curves balance as it has changed
            const balanceCacheKey = this.getCurvesBalanceCacheKey(
                curves,
                this.getAddress(),
                subject
            );
            this.invalidateData(balanceCacheKey);

            return result;
        } catch (error) {
            throw new Error(`[plugin-form] failed to deposit: ${error}`);
        }
    }

    public async mintCurvesERC20Token(
        curves: Address,
        name: string,
        symbol: string
    ) {
        try {
            return await this.sendTransaction({
                to: curves,
                abi: this.curves.abi,
                functionName: "setNameAndSymbol", // setNameAndSymbol with 'mintNow = true'
                args: [name, symbol, true],
            });
        } catch (error) {
            throw new Error(
                `[plugin-form] failed to set ERC20 metadata: ${error}`
            );
        }
    }

    public async getCurvesERC20TokenDetails(
        curves: Address,
        subject?: Address
    ) {
        try {
            const cacheKey = `${this.chain.id}_curves_erc20_${curves}_${subject}`;
            const cachedToken = await this.getCachedData<string>(cacheKey);
            if (cachedToken) {
                elizaLogger.log(
                    `[plugin-form] returning cached curves ERC20 token details [chain: ${this.chain.name} | curves: ${curves} | address: ${subject}]`
                );
                return JSON.parse(cachedToken);
            }

            const address = subject || this.getAddress();
            const result = await this.read({
                address: curves,
                abi: this.curves.abi,
                functionName: "externalCurvesTokens",
                args: [address],
            });

            const erc20: ERC20 = {
                name: result[0],
                symbol: result[1],
                decimals: 18,
                address: result[2],
            };
            this.setCachedData(cacheKey, JSON.stringify(erc20));
            elizaLogger.log(
                `[plugin-form] curves ERC20 token details cached for [chain: ${this.chain.name} | curves: ${curves} | address: ${subject}]`
            );

            return erc20;
        } catch (error) {
            throw new Error(`[plugin-form] failed to get ERC20 info: ${error}`);
        }
    }

    private getCurvesBalanceCacheKey(
        curves: Address,
        owner: Address,
        subject: Address
    ): string {
        return `${this.chain.id}_curves_balance_${curves}_${owner}_${subject}`;
    }

    public async getCurvesTokenBalance(
        curves: Address,
        owner: Address,
        subject: Address
    ): Promise<bigint> {
        try {
            const cacheKey = this.getCurvesBalanceCacheKey(
                curves,
                owner,
                subject
            );
            const cachedBalance = await this.getCachedData<bigint>(cacheKey);

            if (cachedBalance) {
                elizaLogger.debug(
                    `[plugin-form] using cached balance [chain: ${this.chain.id} | curves: ${curves} | subject: ${subject}]`
                );
                return BigInt(cachedBalance);
            }

            const result = await this.read({
                address: curves,
                abi: this.curves.abi,
                functionName: "curvesTokenBalance",
                args: [subject, owner],
            });

            // Assert result type
            let balance: bigint;
            if (typeof result === "bigint") {
                balance = result;
            } else if (
                typeof result === "string" ||
                typeof result === "number"
            ) {
                // Handle other potential return types
                balance = BigInt(result);
            }
            await this.setCachedData(cacheKey, balance.toString());

            elizaLogger.info(
                `[plugin-form] balance: ${balance.toString()} [curves: ${curves.slice(0, 6)}...${curves.slice(-4)}]`
            );
            return balance;
        } catch (error) {
            throw new Error(
                `[plugin-form] failed to get curves balance: ${error}`
            );
        }
    }

    public async getCurvesBuyPrice(
        curves: Address,
        subject: Address,
        amount: number = 1
    ): Promise<bigint> {
        try {
            const cacheKey = `${this.chain.id}_curves_buy_price_${curves}_${subject}_${amount}`;
            const cachedPrice = await this.getCachedData<bigint>(cacheKey);

            if (cachedPrice) {
                elizaLogger.debug(
                    `[plugin-form] using cached buy price [chain: ${this.chain.id} | amount: ${amount}]`
                );
                return BigInt(cachedPrice);
            }

            const result = await this.read({
                address: curves,
                abi: this.curves.abi,
                functionName: "getBuyPrice",
                args: [subject, amount],
            });

            // Assert result type
            let price: bigint;
            if (typeof result === "bigint") {
                price = result;
            } else if (
                typeof result === "string" ||
                typeof result === "number"
            ) {
                // Handle other potential return types
                price = BigInt(result);
            }
            await this.setCachedData(cacheKey, price.toString());

            elizaLogger.info(
                `[plugin-form] buy price: ${formatUnits(price, 18)} ETH [amount: ${amount}]`
            );
            return price;
        } catch (error) {
            throw new Error(`[plugin-form] failed to get buy price: ${error}`);
        }
    }

    public async getCurvesSellPrice(
        curves: Address,
        subject: Address,
        amount: number = 1
    ): Promise<bigint> {
        try {
            const cacheKey = `${this.chain.id}_curves_sell_price_${curves}_${subject}_${amount}`;
            const cachedPrice = await this.getCachedData<bigint>(cacheKey);

            if (cachedPrice) {
                elizaLogger.debug(
                    `[plugin-form] using cached sell price [chain: ${this.chain.id} | amount: ${amount}]`
                );
                return BigInt(cachedPrice);
            }

            const result = await this.read({
                address: curves,
                abi: this.curves.abi,
                functionName: "getSellPrice",
                args: [subject, amount],
            });

            // Assert result type
            let price: bigint;
            if (typeof result === "bigint") {
                price = result;
            } else if (
                typeof result === "string" ||
                typeof result === "number"
            ) {
                // Handle other potential return types
                price = BigInt(result);
            }
            await this.setCachedData(cacheKey, price.toString());

            elizaLogger.info(
                `[plugin-form] sell price: ${formatUnits(price, 18)} ETH [amount: ${amount}]`
            );
            return price;
        } catch (error) {
            elizaLogger.error(
                `[plugin-form] failed to get sell price for ${subject}:`,
                error
            );
            throw error;
        }
    }
}

export const formWalletProvider: Provider = {
    async get(
        runtime: IAgentRuntime,
        _message: Memory,
        state?: State
    ): Promise<string | null> {
        try {
            const isTestnet = runtime.getSetting("FORM_TESTNET") === "true";
            const privateKey = runtime.getSetting(
                "FORM_PRIVATE_KEY"
            ) as `0x${string}`;

            if (!privateKey) {
                throw new Error("FORM_PRIVATE_KEY is missing");
            }

            const wallet = new FormWalletClient(
                privateKey,
                runtime.cacheManager,
                isTestnet
            );
            const address = wallet.getAddress();
            const chain = wallet.getChain();
            const agentName =
                state?.agentName || runtime.character.name || "The agent";

            return `${agentName}'s Form Wallet Address: ${address}\nChain: ${chain.name}`;
        } catch (error) {
            elizaLogger.error(
                "[plugin-form] Error in Form wallet provider:",
                error
            );
            return null;
        }
    },
};
