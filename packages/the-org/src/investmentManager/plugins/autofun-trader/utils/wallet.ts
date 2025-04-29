import { logger, type IAgentRuntime, parseJSONObjectFromText } from '@elizaos/core';
import { Connection, Keypair, VersionedTransaction, PublicKey } from '@solana/web3.js';
import { decodeBase58 } from './utils';

/**
 * Gets wallet keypair from runtime settings
 * @param runtime Agent runtime environment
 * @returns Solana keypair for transactions
 * @throws Error if private key is missing or invalid
 */
export function getWalletKeypair(runtime?: IAgentRuntime): Keypair {
  const privateKeyString = runtime?.getSetting('SOLANA_PRIVATE_KEY');
  if (!privateKeyString) {
    throw new Error('No wallet private key configured');
  }

  try {
    const privateKeyBytes = decodeBase58(privateKeyString);
    return Keypair.fromSecretKey(privateKeyBytes);
  } catch (error) {
    logger.error('Failed to create wallet keypair:', error);
    throw error;
  }
}

/**
 * Gets current SOL balance for wallet
 * @param runtime Agent runtime environment
 * @returns Balance in SOL
 */
export async function getWalletBalance(runtime: IAgentRuntime): Promise<number> {
  try {
    const walletKeypair = getWalletKeypair(runtime);
    const connection = new Connection(runtime.getSetting('RPC_URL'));
    const balance = await connection.getBalance(walletKeypair.publicKey);
    const solBalance = balance / 1e9;

    logger.log('Fetched wallet balance:', {
      address: walletKeypair.publicKey.toBase58(),
      solBalance,
    });

    return solBalance;
  } catch (error) {
    logger.error('Failed to get wallet balance:', error);
    return 0;
  }
}

// Add helper function to get connection
async function getConnection(runtime: IAgentRuntime): Promise<Connection> {
  return new Connection(
    runtime.getSetting('RPC_URL') || 'https://zondra-wil7oz-fast-mainnet.helius-rpc.com'
  );
}

// Add configuration constants
const CONFIRMATION_CONFIG = {
  MAX_ATTEMPTS: 12, // Increased from 8
  INITIAL_TIMEOUT: 2000, // 2 seconds
  MAX_TIMEOUT: 20000, // 20 seconds
  // Exponential backoff between retries
  getDelayForAttempt: (attempt: number) => Math.min(2000 * 1.5 ** attempt, 20000),
};

// Add function to calculate dynamic slippage
function calculateDynamicSlippage(amount: string, quoteData: any): number {
  const baseSlippage = 0.45;
  const priceImpact = Number.parseFloat(quoteData?.priceImpactPct || '0');
  const amountNum = Number(amount);

  let dynamicSlippage = baseSlippage;

  if (priceImpact > 1) {
    dynamicSlippage += priceImpact * 0.5;
  }

  if (amountNum > 10000) {
    dynamicSlippage *= 1.5;
  }

  return Math.min(dynamicSlippage, 2.5);
}

/**
 * Execute a trade with detailed logging
 */
export async function executeTrade(
  runtime: IAgentRuntime,
  params: {
    tokenAddress: string;
    amount: string;
    slippage: number;
    dex: string;
    action: string;
  }
): Promise<{
  success: boolean;
  signature?: string;
  error?: string;
  receivedAmount?: string;
  receivedValue?: string;
}> {
  const actionStr = params.action === 'SELL' ? 'sell' : 'buy';
  logger.info(`Executing ${actionStr} trade using ${params.dex}:`, {
    tokenAddress: params.tokenAddress,
    amount: params.amount,
    slippage: params.slippage,
  });

  try {
    const walletKeypair = getWalletKeypair(runtime);
    const connection = new Connection(runtime.getSetting('RPC_URL'));

    // Setup swap parameters
    const SOL_ADDRESS = 'So11111111111111111111111111111111111111112';
    const inputTokenCA = params.action === 'SELL' ? params.tokenAddress : SOL_ADDRESS;
    const outputTokenCA = params.action === 'SELL' ? SOL_ADDRESS : params.tokenAddress;

    // Convert amount to lamports for the API
    const swapAmount =
      params.action === 'SELL'
        ? Number(params.amount) // For selling, amount is already in lamports
        : Math.floor(Number(params.amount) * 1e9); // For buying, convert to lamports

    /*
    console.log("utils::wallet - executeTrade get quote", {
      inputTokenCA, outputTokenCA, slippage: params.slippage, calcSlip: Math.floor(params.slippage * 10000),
    })
    */

    // Get quote using Jupiter API

    // 100 is 1%, we don't need to scale it by 10k
    // 10k is if we gave it 0.01 to mean 1%
    const quoteResponse = await fetch(
      `https://public.jupiterapi.com/quote?inputMint=${inputTokenCA}&outputMint=${outputTokenCA}&amount=${swapAmount}&slippageBps=${params.slippage}&platformFeeBps=200`
    );

    if (!quoteResponse.ok) {
      const error = await quoteResponse.text();
      // {\"error\":\"The token GkpRhRXqVYUJS2gMPLyjefAcwLMCLwoxaBKRr1ghnu1k is not tradable\",\"errorCode\":\"TOKEN_NOT_TRADABLE\"}
      const parsedResponse = parseJSONObjectFromText(error);
      if (parsedResponse?.errorCode === 'TOKEN_NOT_TRADABLE') {
        function extractTokenAddress(message) {
          const regex = /The token (\w{44}) is not tradable/;
          const match = message.match(regex);
          return match ? match[1] : null;
        }
        logger.log('Need to flag', extractTokenAddress(parsedResponse.error), 'as not tradable');
        //
      }

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

    // Calculate dynamic slippage based on market conditions
    const dynamicSlippage = calculateDynamicSlippage(params.amount.toString(), quoteData);
    logger.info('Using dynamic slippage:', {
      baseSlippage: params.slippage,
      dynamicSlippage,
      priceImpact: quoteData?.priceImpactPct,
    });

    // Update quote with dynamic slippage
    const swapResponse = await fetch('https://public.jupiterapi.com/swap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: {
          ...quoteData,
          slippageBps: Math.floor(dynamicSlippage * 10000),
        },
        userPublicKey: walletKeypair.publicKey.toString(),
        wrapAndUnwrapSol: true,
        computeUnitPriceMicroLamports: 5000000,
        dynamicComputeUnitLimit: true,
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

    // Improve confirmation checking with exponential backoff
    let confirmed = false;
    for (let i = 0; i < CONFIRMATION_CONFIG.MAX_ATTEMPTS; i++) {
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

        // Calculate delay with exponential backoff
        const delay = CONFIRMATION_CONFIG.getDelayForAttempt(i);
        logger.info(
          `Waiting ${delay}ms before next confirmation check (attempt ${i + 1}/${CONFIRMATION_CONFIG.MAX_ATTEMPTS})`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      } catch (error) {
        logger.warn(`Confirmation check ${i + 1} failed:`, error);

        if (i === CONFIRMATION_CONFIG.MAX_ATTEMPTS - 1) {
          throw new Error('Could not confirm transaction status');
        }

        // Wait before retry with exponential backoff
        const delay = CONFIRMATION_CONFIG.getDelayForAttempt(i);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    if (!confirmed) {
      throw new Error('Could not confirm transaction status');
    }

    logger.log('Trade executed successfully:', {
      type: params.action === 'SELL' ? 'sell' : 'buy',
      tokenAddress: params.tokenAddress,
      amount: params.amount,
      signature,
      explorer: `https://solscan.io/tx/${signature}`,
    });

    return {
      success: true,
      signature,
      receivedAmount: params.amount,
      receivedValue: params.amount,
    };
  } catch (error) {
    logger.error('Trade execution failed:', {
      error: error instanceof Error ? error.message : 'Unknown error',
      params: {
        tokenAddress: params.tokenAddress,
        amount: params.amount,
        slippage: params.slippage,
        dex: params.dex,
        action: params.action,
      },
      errorStack: error instanceof Error ? error.stack : undefined,
    });

    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

async function executeRaydiumTrade(
  runtime: IAgentRuntime,
  params: {
    tokenAddress: string;
    amount: string;
    slippage: number;
    isSell?: boolean;
  }
): Promise<{ success: boolean; signature?: string; error?: string }> {
  try {
    const walletKeypair = getWalletKeypair(runtime);
    const connection = await getConnection(runtime);
    const SOL_ADDRESS = 'So11111111111111111111111111111111111111112';

    // Get quote from Raydium API
    const quoteResponse = await fetch('https://api.raydium.io/v2/main/quote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        inputMint: params.isSell ? params.tokenAddress : SOL_ADDRESS,
        outputMint: params.isSell ? SOL_ADDRESS : params.tokenAddress,
        amount: params.amount,
        slippage: params.slippage * 100, // Raydium uses percentage
        onlyDirectRoute: true, // For faster execution
      }),
    });

    if (!quoteResponse.ok) {
      throw new Error(`Raydium quote failed: ${await quoteResponse.text()}`);
    }

    const quoteData = await quoteResponse.json();
    logger.log('Raydium quote received:', quoteData);

    // Get swap transaction
    const swapResponse = await fetch('https://api.raydium.io/v2/main/swap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...quoteData,
        wallet: walletKeypair.publicKey.toString(),
        computeUnitPriceMicroLamports: 5000000,
      }),
    });

    const swapData = await swapResponse.json();
    if (!swapData?.swapTransaction) {
      throw new Error('No swap transaction returned');
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

    // Improve confirmation checking
    let confirmed = false;
    for (let i = 0; i < 8; i++) {
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
          });
          break;
        }

        const delay = Math.min(1000 * 1.5 ** i, 10000);
        await new Promise((resolve) => setTimeout(resolve, delay));
      } catch (error) {
        logger.warn(`Confirmation check ${i + 1} failed:`, error);
      }
    }

    if (!confirmed) {
      throw new Error('Could not confirm transaction status');
    }

    logger.log('Trade executed successfully:', {
      type: params.isSell ? 'sell' : 'buy',
      tokenAddress: params.tokenAddress,
      amount: params.amount,
      signature,
      explorer: `https://solscan.io/tx/${signature}`,
    });

    return {
      success: true,
      signature,
    };
  } catch (error) {
    logger.error('Raydium trade execution failed:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

export async function getChainWalletBalance(
  runtime: IAgentRuntime,
  _tokenAddress: string
): Promise<number> {
  // Get Solana balance
  return await getWalletBalance(runtime);
}

// Add this helper function at the top level
export async function simulateTransaction(client: any, tx: any): Promise<string> {
  try {
    const result = await client.call({
      account: client.account,
      to: tx.to,
      data: tx.data,
      value: tx.value,
      gas: tx.gas,
      gasPrice: tx.gasPrice,
    });
    return result;
  } catch (error) {
    return `Simulation failed: ${error.message}`;
  }
}

interface TokenBalance {
  mint: string;
  balance: number;
  decimals: number;
  uiAmount: number;
}

/**
 * Gets all token balances for a wallet including SOL and SPL tokens
 */
export async function getWalletBalances(runtime: IAgentRuntime) {
  try {
    const walletKeypair = getWalletKeypair(runtime);
    const connection = new Connection(runtime.getSetting('RPC_URL'));

    const solBalance = await connection.getBalance(walletKeypair.publicKey);
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(walletKeypair.publicKey, {
      programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
    });

    const balances = {
      solBalance: solBalance / 1e9,
      tokens: tokenAccounts.value.map((account) => ({
        mint: account.account.data.parsed.info.mint,
        balance: account.account.data.parsed.info.tokenAmount.amount,
        decimals: account.account.data.parsed.info.tokenAmount.decimals,
        uiAmount: account.account.data.parsed.info.tokenAmount.uiAmount,
      })),
    };

    //logger.log('Fetched wallet balances:', balances);
    return balances;
  } catch (error) {
    logger.error('Failed to get wallet balances:', error);
    return {
      solBalance: 0,
      tokens: [],
    };
  }
}

/**
 * Gets balance of a specific token
 */
export async function getTokenBalance(
  runtime: IAgentRuntime,
  tokenMint: string
): Promise<TokenBalance | null> {
  try {
    const balances = await getWalletBalances(runtime);
    const token = balances.tokens.find((t) => t.mint.toLowerCase() === tokenMint.toLowerCase());

    if (!token) {
      logger.warn(`No balance found for token ${tokenMint}`, {
        availableTokens: balances.tokens.map((t) => t.mint),
      });
    }

    return token;
  } catch (error) {
    logger.error('Failed to get token balance:', error);
    return null;
  }
}

/**
 * Checks if wallet has any balance of a specific token
 */
export async function hasTokenBalance(runtime: IAgentRuntime, tokenMint: string): Promise<boolean> {
  const balance = await getTokenBalance(runtime, tokenMint);
  return balance !== null && balance.uiAmount > 0;
}
