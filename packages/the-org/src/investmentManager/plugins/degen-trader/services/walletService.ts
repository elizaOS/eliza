import { type IAgentRuntime, logger } from '@elizaos/core';
import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import { calculateDynamicSlippage } from '../utils/analyzeTrade';
import bs58 from 'bs58';

export interface WalletOperationResult {
  success: boolean;
  signature?: string;
  error?: string;
  outAmount?: string;
  receivedAmount?: string;
  swapUsdValue?: string;
}

export class WalletService {
  private connection: Connection | null = null;
  private keypair: Keypair | null = null;
  public CONFIRMATION_CONFIG: any;

  constructor(private runtime: IAgentRuntime) {
    // Add configuration constants
    this.CONFIRMATION_CONFIG = {
      MAX_ATTEMPTS: 12, // Increased from 8
      INITIAL_TIMEOUT: 2000, // 2 seconds
      MAX_TIMEOUT: 20000, // 20 seconds
      // Exponential backoff between retries
      getDelayForAttempt: (attempt: number) => Math.min(2000 * Math.pow(1.5, attempt), 20000),
    };
  }

  async initialize(): Promise<void> {
    try {
      // Initialize Solana connection
      const rpcUrl = this.runtime.getSetting('SOLANA_RPC_URL');
      if (!rpcUrl) {
        throw new Error('Solana RPC URL not configured');
      }
      this.connection = new Connection(rpcUrl);

      // Initialize wallet
      const privateKey = this.runtime.getSetting('SOLANA_PRIVATE_KEY');
      if (!privateKey) {
        throw new Error('Solana private key not configured');
      }

      const decodedKey = bs58.decode(privateKey);
      //console.log('decodedKey', decodedKey)
      this.keypair = Keypair.fromSecretKey(decodedKey);
      //console.log('keypair3', this.keypair.publicKey.toString())

      logger.info('Wallet service initialized successfully');
    } catch (error) {
      console.log('Failed to initialize wallet service:', error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.connection = null;
    this.keypair = null;
  }

  async getWallet() {
    if (!this.keypair || !this.connection) {
      throw new Error('Wallet not initialized');
    }

    const keypair = this.keypair;

    return {
      publicKey: this.keypair.publicKey,
      connection: this.connection,
      CONFIRMATION_CONFIG: this.CONFIRMATION_CONFIG,

      async executeTrade(
        {
          tokenAddress,
          amount,
          slippage,
          action,
        }: {
          tokenAddress: string;
          amount: string | number;
          slippage: number;
          action: 'BUY' | 'SELL';
        },
        dex = 'jup'
      ): Promise<WalletOperationResult> {
        const actionStr = action === 'SELL' ? 'sell' : 'buy';
        logger.info(`Executing ${actionStr} trade using ${dex}:`, {
          tokenAddress,
          amount,
          slippage,
        });

        try {
          const walletKeypair = keypair; //getWalletKeypair(runtime);
          console.log('walletKeypair', walletKeypair.publicKey.toString());
          //const connection = new Connection(runtime.getSetting("RPC_URL"));
          const connection = this.connection;

          // Setup swap parameters
          const SOL_ADDRESS = 'So11111111111111111111111111111111111111112';
          const inputTokenCA = action === 'SELL' ? tokenAddress : SOL_ADDRESS;
          const outputTokenCA = action === 'SELL' ? SOL_ADDRESS : tokenAddress;

          // Convert amount to lamports for BUY (SOL is input)
          const swapAmount =
            action === 'BUY'
              ? Math.floor(Number(amount) * 1e9) // Convert SOL to lamports for buy
              : Math.floor(Number(amount)); // Amount already in token decimals for sell

          logger.debug('Swap parameters:', {
            inputTokenCA,
            outputTokenCA,
            swapAmount,
            originalAmount: amount,
          });

          // Add validation for swap amount
          if (isNaN(swapAmount) || swapAmount <= 0) {
            throw new Error(`Invalid swap amount: ${swapAmount}`);
          }

          // Get quote using Jupiter API
          /*
          console.log("sell quoteResponse", {
            inputTokenCA, outputTokenCA, slippage, calcSlip: Math.floor(slippage * 10000),
          })
          */
          const quoteResponse = await fetch(
            `https://public.jupiterapi.com/quote?inputMint=${inputTokenCA}&outputMint=${
              outputTokenCA
            }&amount=${swapAmount}&slippageBps=${Math.floor(slippage * 10000)}&platformFeeBps=200`
          );

          if (!quoteResponse.ok) {
            const error = await quoteResponse.text();
            logger.warn('Quote request failed:', {
              status: quoteResponse.status,
              error,
            });
            return {
              success: false,
              error: `Failed to get quote: ${error}`,
            };
          }

          const quoteData = await quoteResponse.json();
          logger.log('Quote received:', quoteData);

          // Validate quote data
          if (!quoteData || !quoteData.outAmount) {
            throw new Error('Invalid quote response: missing output amount');
          }

          // Calculate dynamic slippage based on market conditions
          const dynamicSlippage = calculateDynamicSlippage(amount.toString(), quoteData);

          // Clamp the slippage to a reasonable range (0.1% to 50%)
          const clampedSlippage = Math.min(Math.max(dynamicSlippage, 0.001), 0.5);

          // Convert to basis points (ensuring it stays within safe integer range)
          const slippageBps = Math.min(Math.floor(clampedSlippage * 10000), 5000);

          logger.info('Using dynamic slippage:', {
            baseSlippage: slippage,
            dynamicSlippage,
            clampedSlippage,
            slippageBps,
            priceImpact: quoteData?.priceImpactPct,
          });

          // Update quote with dynamic slippage
          const swapResponse = await fetch('https://public.jupiterapi.com/swap', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              quoteResponse: {
                ...quoteData,
                slippageBps, // Use the clamped and converted value
              },
              feeAccount: '3nMBmufBUBVnk28sTp3NsrSJsdVGTyLZYmsqpMFaUT9J',
              userPublicKey: walletKeypair.publicKey.toString(),
              wrapAndUnwrapSol: true,
              computeUnitPriceMicroLamports: 5000000,
              dynamicComputeUnitLimit: true,
              useSharedAccounts: true,
              simulateTransaction: true,
            }),
          });

          if (!swapResponse.ok) {
            const error = await swapResponse.text();
            logger.error('Swap request failed:', {
              status: swapResponse.status,
              error,
            });
            throw new Error(`Failed to get swap transaction: ${error}`);
          }

          const swapData = await swapResponse.json();
          logger.log('Swap response received:', swapData);

          if (!swapData?.swapTransaction) {
            logger.error('Invalid swap response:', swapData);
            throw new Error('No swap transaction returned in response');
          }

          // Check simulation results
          if (swapData.simulationError) {
            logger.error('Transaction simulation failed:', swapData.simulationError);
            return {
              success: false,
              error: `Simulation failed: ${swapData.simulationError}`,
            };
          }

          // Execute transaction
          const transactionBuf = Buffer.from(swapData.swapTransaction, 'base64');
          const tx = VersionedTransaction.deserialize(transactionBuf);

          // Get fresh blockhash with processed commitment for speed
          const latestBlockhash = await connection.getLatestBlockhash('processed');
          tx.message.recentBlockhash = latestBlockhash.blockhash;
          tx.sign([walletKeypair]);

          // Send transaction
          const signature = await connection.sendRawTransaction(tx.serialize(), {
            skipPreflight: true,
            maxRetries: 5,
            preflightCommitment: 'processed',
          });

          logger.log('Transaction sent with high priority:', {
            signature,
            explorer: `https://solscan.io/tx/${signature}`,
          });

          // Confirm transaction
          let confirmed = false;
          for (let i = 0; i < this.CONFIRMATION_CONFIG.MAX_ATTEMPTS; i++) {
            try {
              const status = await connection.getSignatureStatus(signature);
              if (
                status.value?.confirmationStatus === 'confirmed' ||
                status.value?.confirmationStatus === 'finalized'
              ) {
                confirmed = true;
                logger.log('Transaction confirmed:', {
                  signature,
                  confirmationStatus: status.value.confirmationStatus,
                  slot: status.context.slot,
                  attempt: i + 1,
                });
                break;
              }

              const delay = this.CONFIRMATION_CONFIG.getDelayForAttempt(i);
              logger.info(
                `Waiting ${delay}ms before next confirmation check (attempt ${i + 1}/${this.CONFIRMATION_CONFIG.MAX_ATTEMPTS})`
              );
              await new Promise((resolve) => setTimeout(resolve, delay));
            } catch (error) {
              logger.warn(`Confirmation check ${i + 1} failed:`, error);
              if (i === this.CONFIRMATION_CONFIG.MAX_ATTEMPTS - 1) {
                throw new Error('Could not confirm transaction status');
              }
              const delay = this.CONFIRMATION_CONFIG.getDelayForAttempt(i);
              await new Promise((resolve) => setTimeout(resolve, delay));
            }
          }

          if (!confirmed) {
            throw new Error('Could not confirm transaction status');
          }

          return {
            success: true,
            signature,
            outAmount: quoteData.outAmount,
            swapUsdValue: quoteData.swapUsdValue,
          };
        } catch (error) {
          logger.error('Trade execution failed:', {
            error: error instanceof Error ? error.message : 'Unknown error',
            params: { tokenAddress, amount, slippage, dex, action },
            errorStack: error instanceof Error ? error.stack : undefined,
          });

          return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
          };
        }
      },

      async buy({ tokenAddress, amountInSol, slippageBps }): Promise<WalletOperationResult> {
        try {
          // Execute buy using Jupiter or other DEX
          const result = await this.executeTrade({
            tokenAddress,
            amount: amountInSol,
            slippage: slippageBps / 10000,
            action: 'BUY',
          });

          return result;
        } catch (error) {
          logger.error('Error executing buy in wallet', error);
          return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },

      async sell({ tokenAddress, tokenAmount, slippageBps }): Promise<WalletOperationResult> {
        try {
          // Execute sell using Jupiter or other DEX
          const result = await this.executeTrade({
            tokenAddress,
            amount: tokenAmount,
            slippage: slippageBps / 10000,
            action: 'SELL',
          });

          return result;
        } catch (error) {
          console.log('Error executing sell in wallet', error);
          return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
    };
  }

  async getBalance(): Promise<number> {
    if (!this.keypair || !this.connection) {
      throw new Error('Wallet not initialized');
    }

    try {
      const balance = await this.connection.getBalance(this.keypair.publicKey);
      return balance / 1e9; // Convert lamports to SOL
    } catch (error) {
      console.log('Error getting wallet balance:', error);
      throw error;
    }
  }
}
