import { elizaLogger } from "@elizaos/core";
import {
    UserSigner,
    Address,
    TransactionComputer,
    MessageComputer,
    ApiNetworkProvider,
    UserSecretKey,
    TokenTransfer,
    TransferTransactionsFactory,
    TransactionsFactoryConfig,
    Token,
    type Transaction,
    TokenManagementTransactionsFactory,
    Message,
    AccountOnNetwork,
    FungibleTokenOfAccountOnNetwork,
} from "@multiversx/sdk-core";
import { denominateAmount, getRawAmount } from "../utils/amount";
import { MVX_NETWORK_CONFIG } from "../constants";

// WalletProvider class handles wallet-related operations, such as signing transactions, retrieving balance, and sending tokens
export class WalletProvider {
    private signer: UserSigner; // Handles cryptographic signing
    private apiNetworkProvider: ApiNetworkProvider; // Interacts with the MultiversX network
    private chainID: string; // Current network chain ID
    private explorerURL: string; // Current network explorer URL
    private minEGLD = 0.0005; // Minimum balance for EGLD, in order to cover gas fees

    /**
     * Constructor to initialize WalletProvider with a private key and network configuration
     * @param privateKey - User's private key for signing transactions
     * @param network - Target network (mainnet, devnet, or testnet)
     */
    constructor(privateKey: string, network: string) {
        if (!MVX_NETWORK_CONFIG[network]) {
            throw new Error(`Unsupported network: ${network}`); // Validate network
        }

        const networkConfig = MVX_NETWORK_CONFIG[network];
        this.chainID = networkConfig.chainID;
        this.explorerURL = networkConfig.explorerURL;

        // Initialize the signer with the user's private key
        const secretKey = UserSecretKey.fromString(privateKey);
        this.signer = new UserSigner(secretKey);

        // Set up the network provider for API interactions
        this.apiNetworkProvider = new ApiNetworkProvider(networkConfig.apiURL, {
            clientName: "eliza-mvx",
        });
    }

    /**
     * Retrieve the wallet address derived from the private key
     * @returns Address object
     */
    public getAddress(): Address {
        return this.signer.getAddress();
    }

    /**
     * Fetch the wallet's current EGLD balance
     * @returns Promise resolving to the wallet's balance as a string
     */
    public async getBalance(): Promise<string> {
        const address = new Address(this.getAddress());
        const account = await this.getAccount(address);
        return account.balance.toString(); // Return balance as a string
    }

    /**
     * Fetch the wallet's current EGLD balance
     * @returns Promise resolving to the wallet's balance as a string
     */
    public async getFungibleBalance(token: string): Promise<string> {
        const data = await this.getTokenData(token);
        const { balance, rawResponse } = data;
        const amount = getRawAmount({
            amount: balance.toString(),
            decimals: rawResponse.decimals,
        });

        return amount;
    }

    /**
     * Sign a transaction using the wallet's private key
     * @param transaction - The transaction object to sign
     * @returns The transaction signature as a string
     */
    public async signTransaction(transaction: Transaction) {
        const computer = new TransactionComputer();
        const serializedTx = computer.computeBytesForSigning(transaction); // Prepare transaction for signing
        const signature = await this.signer.sign(serializedTx); // Sign the transaction
        return signature;
    }

    /**
     * Send EGLD tokens to another wallet
     * @param receiverAddress - Recipient's wallet address
     * @param amount - Amount of EGLD to send
     * @returns Transaction hash as a string
     */
    public async sendEGLD({
        receiverAddress,
        amount,
    }: {
        receiverAddress: string;
        amount: string;
    }): Promise<string> {
        try {
            const hasEgldBalance = await this.hasEgldBalance(amount);

            if (!hasEgldBalance) {
                throw new Error("Insufficient balance.");
            }

            const receiver = new Address(receiverAddress);
            const value = denominateAmount({ amount, decimals: 18 }); // Convert amount to the smallest unit
            const senderAddress = this.getAddress();

            // Prepare the transaction factory with the current chain ID
            const factoryConfig = new TransactionsFactoryConfig({
                chainID: this.chainID,
            });
            const factory = new TransferTransactionsFactory({
                config: factoryConfig,
            });

            // Create a native EGLD transfer transaction
            const transaction = factory.createTransactionForNativeTokenTransfer(
                {
                    sender: this.getAddress(),
                    receiver: receiver,
                    nativeAmount: BigInt(value),
                },
            );

            // Get the sender's account details to set the nonce
            const account = await this.getAccount(senderAddress);
            transaction.nonce = BigInt(account.nonce);

            // Sign the transaction
            const signature = await this.signTransaction(transaction);
            transaction.signature = signature;

            // Broadcast the transaction to the network
            const txHash = await this.sendTransaction(transaction);

            elizaLogger.log(`TxHash: ${txHash}`); // Log transaction hash
            elizaLogger.log(
                `Transaction URL: ${this.explorerURL}/transactions/${txHash}`,
            ); // View Transaction
            return txHash;
        } catch (error) {
            console.error("Error sending EGLD transaction:", error);
            throw new Error(
                `Failed to send EGLD: ${error.message || "Unknown error"}`,
            );
        }
    }

    /**
     * Send ESDT (eStandard Digital Token) tokens to another wallet
     * @param receiverAddress - Recipient's wallet address
     * @param amount - Amount of ESDT to send
     * @param identifier - ESDT token identifier (e.g., PEPE-3eca7c)
     * @returns Transaction hash as a string
     */
    public async sendESDT({
        receiverAddress,
        amount,
        identifier,
    }: {
        receiverAddress: string;
        amount: string;
        identifier: string;
    }): Promise<string> {
        try {
            const hasEgldBalance = await this.hasEgldBalance();

            if (!hasEgldBalance) {
                throw new Error(
                    `Insufficient balance, wallet should have a minimum of ${this.minEGLD} EGLD`,
                );
            }

            const tokenBalance = await this.getFungibleBalance(identifier);

            const tokenBalanceNum = Number(tokenBalance);
            const transferAmountNum = Number(amount);

            // Perform the calculation and comparison
            const hasBalance =
                tokenBalanceNum >= tokenBalanceNum - transferAmountNum;

            if (!hasBalance) {
                throw new Error("Insufficient balance for token transfer");
            }

            // Set up transaction factory for ESDT transfers
            const config = new TransactionsFactoryConfig({
                chainID: this.chainID,
            });
            const factory = new TransferTransactionsFactory({ config });

            // Retrieve token details to determine the token's decimals
            const token = await this.getTokenData(identifier);

            // Convert amount to the token's smallest unit
            const value = denominateAmount({
                amount,
                decimals: token.rawResponse.decimals,
            });

            const address = this.getAddress();

            // Create an ESDT transfer transaction
            const transaction = factory.createTransactionForESDTTokenTransfer({
                sender: address,
                receiver: new Address(receiverAddress),
                tokenTransfers: [
                    new TokenTransfer({
                        token: new Token({ identifier }),
                        amount: BigInt(value),
                    }),
                ],
            });

            // Set the transaction nonce
            const account = await this.getAccount(address);
            transaction.nonce = BigInt(account.nonce);

            // Sign and broadcast the transaction
            const signature = await this.signTransaction(transaction);
            transaction.signature = signature;
            const txHash = await this.sendTransaction(transaction);

            const transactionURL = this.getTransactionURL(txHash);
            elizaLogger.log(`TxHash: ${txHash}`); // Log transaction hash
            elizaLogger.log(`Transaction URL: ${transactionURL}`); // View Transaction
            return txHash;
        } catch (error) {
            console.error("Error sending ESDT transaction:", error);
            throw new Error(
                `Failed to send ESDT: ${error.message || "Unknown error"}`,
            );
        }
    }

    /**
     * Create a new eStandard Digital Token (ESDT).
     * @param tokenName - The name of the token to be created.
     * @param tokenTicker - The ticker symbol for the token.
     * @param amount - The initial supply of the token.
     * @param decimals - The number of decimal places for the token.
     * @returns The transaction hash of the created ESDT.
     */
    public async createESDT({
        tokenName,
        tokenTicker,
        amount,
        decimals,
    }: {
        tokenName: string;
        tokenTicker: string;
        amount: string;
        decimals: number;
    }): Promise<string> {
        try {
            const hasEgldBalance = await this.hasEgldBalance();

            if (!hasEgldBalance) {
                throw new Error(
                    `Insufficient balance, wallet should have a minimum of ${this.minEGLD} EGLD`,
                );
            }

            const factoryConfig = new TransactionsFactoryConfig({
                chainID: this.chainID, // Set the chain ID for the transaction factory
            });
            const factory = new TokenManagementTransactionsFactory({
                config: factoryConfig, // Initialize the factory with the configuration
            });

            const totalSupply = denominateAmount({ amount, decimals });
            const address = this.getAddress(); // Retrieve the sender's address

            // Create a transaction for issuing a fungible token
            const transaction = factory.createTransactionForIssuingFungible({
                sender: address, // Specify the sender's address
                tokenName, // Name of the token
                tokenTicker: tokenTicker.toUpperCase(), // Token ticker in uppercase
                initialSupply: BigInt(totalSupply), // Initial supply as a BigInt
                numDecimals: BigInt(decimals), // Number of decimals as a BigInt
                canFreeze: false, // Token cannot be frozen
                canWipe: false, // Token cannot be wiped
                canPause: false, // Token cannot be paused
                canChangeOwner: true, // Ownership can be changed
                canUpgrade: true, // Token can be upgraded
                canAddSpecialRoles: true, // Special roles can be added
            });

            // Fetch the account details to set the nonce
            const account = await this.getAccount(address);
            transaction.nonce = BigInt(account.nonce); // Set the nonce for the transaction

            const signature = await this.signTransaction(transaction); // Sign the transaction
            transaction.signature = signature; // Attach the signature to the transaction

            // Send the transaction to the network and get the transaction hash
            const txHash = await this.sendTransaction(transaction);

            const transactionURL = this.getTransactionURL(txHash);
            elizaLogger.log(`TxHash: ${txHash}`); // Log the transaction hash
            elizaLogger.log(`Transaction URL: ${transactionURL}`); // View Transaction

            return txHash; // Return the transaction hash
        } catch (error) {
            console.error("Error creating ESDT:", error);
            throw new Error(
                `Failed to create ESDT: ${error.message || "Unknown error"}`,
            ); // Throw an error if creation fails
        }
    }

    /**
     * Create a transaction URL.
     * @param txHash - Transaction hash
     * @returns The transaction url for the given hash.
     */
    public getTransactionURL(txHash: string) {
        return `${this.explorerURL}/transactions/${txHash}`;
    }

    /**
     * Check if wallet has EGLD balance
     * @param amount - EGLD amount to check
     * @returns boolean
     */
    public async hasEgldBalance(amount?: string) {
        const denominatedBalance = await this.getBalance();
        const rawBalance = getRawAmount({
            amount: denominatedBalance,
            decimals: 18,
        });
        const rawBalanceNum = Number(rawBalance);

        if (amount) {
            const amountNum = Number(amount);
            const hasBalance = rawBalanceNum >= amountNum + this.minEGLD;

            return hasBalance;
        }

        return rawBalanceNum >= this.minEGLD;
    }

    /**
     * Sign a message in order to receiver a signature
     * @param messageToSign - the message to be signed
     * @returns signature as Buffer<ArrayBufferLike>
     */
    public async signMessage(messageToSign: string) {
        const computer = new MessageComputer();
        const message = new Message({
            data: Buffer.from(messageToSign),
        });

        const serializedTx = computer.computeBytesForSigning(message);
        const signature = await this.signer.sign(serializedTx);
        return signature;
    }

    public async sendTransaction(transaction: Transaction): Promise<string> {
        return this.apiNetworkProvider.sendTransaction(transaction);
    }

    public async getAccount(address: Address): Promise<AccountOnNetwork> {
        return this.apiNetworkProvider.getAccount(address);
    }

    public async getTokenData(
        identifier: string,
    ): Promise<FungibleTokenOfAccountOnNetwork> {
        const address = this.getAddress();

        return this.apiNetworkProvider.getFungibleTokenOfAccount(
            address,
            identifier,
        );
    }
}
