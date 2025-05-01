import {
  type IAgentRuntime,
  ModelType,
  logger,
  type UUID,
  parseJSONObjectFromText,
} from '@elizaos/core';
import { BaseTradeService } from '../base/BaseTradeService';
import { TokenValidationService } from '../validation/TokenValidationService';
import { TradeCalculationService } from '../calculation/tradeCalculation';
import { SellSignalMessage } from '../../types';
import { v4 as uuidv4 } from 'uuid';
import { BN, toBN } from '../../utils/bignumber';
import { getTokenBalance } from '../../utils/wallet';
import { TradeMemoryService } from '../tradeMemoryService';
import { WalletService } from '../walletService';
import { DataService } from '../dataService';
import { AnalyticsService } from '../analyticsService';

import { BN, AnchorProvider, Program } from '@coral-xyz/anchor';
import IDL from '../../idl/autofun.json';
import { Autofun } from '../../types/autofun';
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  Transaction,
  VersionedTransaction,
} from '@solana/web3.js';

import { executeTrade } from '../../utils/wallet';

function convertToBasisPoints(feePercent: number): number {
  if (feePercent >= 1) {
    return feePercent;
  }
  return Math.floor(feePercent * 10000);
}

function calculateAmountOutBuy(
  reserveToken: number,
  amount: number,
  _solDecimals: number,
  reserveLamport: number,
  platformBuyFee: number
): number {
  console.log('calculateAmountOutBuy inputs:', {
    reserveToken,
    amount,
    _solDecimals,
    reserveLamport,
    platformBuyFee,
  });

  const feeBasisPoints = new BN(convertToBasisPoints(platformBuyFee));
  console.log('feeBasisPoints:', feeBasisPoints.toString());

  const amountBN = new BN(amount);
  console.log('amountBN:', amountBN.toString());

  const adjustedAmount = amountBN.mul(new BN(10000)).sub(feeBasisPoints).div(new BN(10000));
  console.log('adjustedAmount:', adjustedAmount.toString());

  const reserveTokenBN = new BN(reserveToken.toString());
  console.log('reserveTokenBN:', reserveTokenBN.toString());

  const numerator = (reserveTokenBN as any).mul(adjustedAmount);
  console.log('numerator:', numerator.toString());

  const denominator = new BN(reserveLamport.toString()).add(adjustedAmount);
  console.log('denominator:', denominator.toString());

  const out = numerator.div(denominator).toNumber();
  console.log('final output:', out);
  return out;
}

/**
 * Calculates the amount of SOL received when selling tokens
 */
export function calculateAmountOutSell(
  reserveLamport: number,
  amount: number,
  _tokenDecimals: number,
  platformSellFee: number,
  reserveToken: number
): number {
  // Input validation
  if (reserveLamport < 0) throw new Error('reserveLamport must be non-negative');
  if (amount < 0) throw new Error('amount must be non-negative');
  if (platformSellFee < 0) throw new Error('platformSellFee must be non-negative');
  if (reserveToken < 0) throw new Error('reserveToken must be non-negative');

  const feeBasisPoints = convertToBasisPoints(platformSellFee);
  const amountBN = new BN(amount);

  // Apply fee: adjusted_amount = amount * (10000 - fee_basis_points) / 10000
  const adjustedAmount = amountBN.mul(new BN(10000 - feeBasisPoints)).div(new BN(10000));

  // For selling tokens: amount_out = reserve_lamport * adjusted_amount / (reserve_token + adjusted_amount)
  const numerator = new BN(reserveLamport.toString()).mul(adjustedAmount);
  const denominator = new BN(reserveToken.toString()).add(adjustedAmount);

  if (denominator.isZero()) throw new Error('Division by zero');

  return numerator.div(denominator).toNumber();
}

const FEE_BASIS_POINTS = 10000;

export const getSwapAmount = async (
  configAccount,
  program: Program<any>,
  amount: number,
  style: number,
  reserveToken: number,
  reserveLamport: number
) => {
  console.log('getSwapAmount inputs:', {
    amount,
    style,
    reserveToken,
    reserveLamport,
    platformSellFee: configAccount.platformSellFee,
    platformBuyFee: configAccount.platformBuyFee,
  });
  if (amount === undefined || isNaN(amount)) {
    throw new Error('Invalid amount provided to getSwapAmount');
  }

  // Apply platform fee
  const feePercent =
    style === 1 ? Number(configAccount.platformSellFee) : Number(configAccount.platformBuyFee);
  console.log('feePercent:', feePercent);

  const adjustedAmount = Math.floor((amount * (FEE_BASIS_POINTS - feePercent)) / FEE_BASIS_POINTS);
  console.log('adjustedAmount:', adjustedAmount);

  // Calculate expected output
  let estimatedOutput;
  if (style === 0) {
    console.log('Calculating buy output...');
    // Buy
    estimatedOutput = calculateAmountOutBuy(
      reserveToken,
      adjustedAmount,
      9, // SOL decimals
      reserveLamport,
      feePercent
    );
  } else {
    console.log('Calculating sell output...');
    // Sell
    estimatedOutput = calculateAmountOutSell(
      reserveLamport,
      adjustedAmount,
      6,
      feePercent,
      reserveToken
    );
  }
  console.log('estimatedOutput:', estimatedOutput);

  return {
    estimatedOutput: estimatedOutput,
    priceImpact: '0',
  };
};

export const swapIx = async (
  user: PublicKey,
  token: PublicKey,
  amount: number,
  style: number,
  slippageBps: number = 100,
  program: Program<Autofun>,
  reserveToken: number,
  reserveLamport: number,
  configAccount: ConfigAccount
) => {
  console.log('swapIx', {
    amount,
    style,
    slippageBps,
    reserveToken,
    reserveLamport,
  });
  const estimatedOutputResult = await getSwapAmount(
    configAccount,
    program,
    amount,
    style,
    reserveToken,
    reserveLamport
  );
  const estimatedOutput = estimatedOutputResult.estimatedOutput;
  // Apply slippage to estimated output
  const minOutput = new BN(Math.floor((estimatedOutput * (10000 - slippageBps)) / 10000));

  const deadline = Math.floor(Date.now() / 1000) + 120;

  // Apply the fee instruction to the transaction
  const tx = await program.methods
    .swap(new BN(amount), style, minOutput, new BN(deadline))
    .accounts({
      teamWallet: configAccount.teamWallet,
      user,
      tokenMint: token,
    })
    .instruction();

  return tx;
};

const sellTemplate = `

I want you to give a crypto sell signal based on both the sentiment analysis as well as the wallet token data.
You trade on auto.fun, a token launchpad, a lot of these coins are brand new, won't have a lot of history.
Don't sell tokens where status is locked
The sentiment score has a range of -100 to 100, with -100 indicating extreme negativity and 100 indicating extreme positiveness.
My current balance is {{solana_balance}} SOL, If I have less than 0.3 SOL, I should up the priority on selling something but we don't need to realize a heavy loss over it.

Sentiment analysis:

{{sentiment}}

Wallet tokens:

{{walletData}}

Only return the following JSON:

{
  recommended_sell: "the symbol of the token for example DEGENAI",
  recommend_sell_address: "the address of the token to purchase, for example: 2sCUCJdVkmyXp4dT8sFaA9LKgSMK4yDPi9zLHiwXpump",
  reason: "the reason why you think this is a good sell, and why you chose the specific amount",
  sell_amount: "number, for example: 600.54411 (number amount of tokens to sell)"
}
Do not include any text after the JSON
`;

export class SellService extends BaseTradeService {
  private pendingSells: { [tokenAddress: string]: BN } = {};
  private validationService: TokenValidationService;
  private calculationService: TradeCalculationService;
  private tradeMemoryService: TradeMemoryService;

  constructor(
    runtime: IAgentRuntime,
    walletService: WalletService,
    dataService: DataService,
    analyticsService: AnalyticsService,
    tradeMemoryService: TradeMemoryService
  ) {
    super(runtime, walletService, dataService, analyticsService);
    this.validationService = new TokenValidationService(
      runtime,
      walletService,
      dataService,
      analyticsService
    );
    this.calculationService = new TradeCalculationService(
      runtime,
      walletService,
      dataService,
      analyticsService
    );
    this.tradeMemoryService = tradeMemoryService;
  }

  async initialize(): Promise<void> {
    logger.info('Initializing sell service');
  }

  async stop(): Promise<void> {
    this.pendingSells = {};
  }

  // https://github.com/elizaOS/auto.fun/blob/7b9c4e6a38ff93c882a87198388e5381a3d40a7a/packages/client/src/utils/swapUtils.ts#L37
  // https://github.com/elizaOS/auto.fun/blob/7b9c4e6a38ff93c882a87198388e5381a3d40a7a/packages/client/src/hooks/use-swap.ts#L3
  async generateSignal() {
    console.log('sell-signal - start');
    // Replace the cache lookup with direct wallet balance check
    const walletBalances = await this.walletService.getWalletBalances();
    const walletData = walletBalances.tokens.map((token) => ({
      mint: token.mint,
      balance: token.uiAmount,
    }));
    //console.log('walletData', walletData)
    const CAs = walletData.map((t) => t.mint);
    const baseUrl = 'https://api.auto.fun/api/token/';
    const tokenRes = await Promise.all(CAs.map((CA) => fetch(baseUrl + CA)));
    const tokenData = await Promise.all(tokenRes.map((res) => res.json()));
    //console.log('tokenData', tokenData)
    const goodAfTokens = tokenData.filter((t) => !t.error);
    console.log(
      'goodAfTokens',
      goodAfTokens.map((t) => [t.name, t.id, t.status])
    );

    // autofun program autoUmixaMaYKFjexMpQuBpNYntgbkzCo2b1ZqUaAZ5

    // t.id for the ca

    // inject into prompt
    let prompt = sellTemplate;
    prompt = prompt.replace(
      '{{sentiment}}',
      'The highly technical analysis is: buy whatever dude 100'
    );

    let latestTxt =
      '\nCurrent Auto.fun list of all active cryptocurrencies with latest market data:\n';
    let idx = 1;
    const fields = [
      'id',
      'name',
      'ticker',
      'url',
      'twitter',
      'telegram',
      'discord',
      'farcaster',
      'description',
      'liquidity',
      'currentPrice',
      'tokenSupplyUiAmount',
      'holderCount',
      'volume24h',
      'price24hAgo',
      'priceChange24h',
      'curveProgress',
      'imported',
      'status',
    ];
    const remaps = {
      ticker: 'symbol',
    };
    latestTxt +=
      'your balance, id, name, symbol, url, twitter, telegram, discord, farcaster, description, liquidity, currentPrice, tokenSupplyUiAmount, holderCount, volume24h, price24hAgo, priceChange24h, curveProgress, imported, status';
    latestTxt += '\n';
    for (const t of goodAfTokens) {
      const tokenBalance = walletData.find((a) => a.mint === t.id).balance;
      const out = [tokenBalance];
      for (const f of fields) {
        let val = t[f];
        if (val?.replaceAll) {
          val = val.replaceAll('\n', ' ');
        }
        out.push(val);
      }
      latestTxt += out.join(', ') + '\n';
    }

    prompt = prompt.replace('{{walletData}}', latestTxt);

    // get balance from plugin-solana
    const walletBalance = await this.walletService.getBalance();
    prompt = prompt.replace('{{solana_balance}}', walletBalance);

    // Get sell recommendation from model
    let responseContent: ISellSignalOutput | null = null;
    let retries = 0;
    const maxRetries = 3;

    while (
      retries < maxRetries &&
      (!responseContent?.recommended_sell ||
        !responseContent?.reason ||
        !responseContent?.recommend_sell_address)
    ) {
      const response = await this.runtime.useModel(ModelType.TEXT_LARGE, {
        prompt: prompt,
        system: 'You are a sell signal analyzer.',
        temperature: 0.2,
        maxTokens: 4096,
        object: true,
      });

      responseContent = parseJSONObjectFromText(response) as ISellSignalOutput;
      retries++;

      if (
        !responseContent?.recommended_sell &&
        !responseContent?.reason &&
        !responseContent?.recommend_sell_address
      ) {
        logger.warn('*** Missing required fields, retrying... generateSignal ***');
      }
    }

    if (!responseContent?.recommend_sell_address) {
      logger.warn('sell-signal::generateSignal - no sell recommendation');
      return false;
    }

    // Validate token address format
    if (!responseContent?.recommend_sell_address?.match(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)) {
      logger.error('Invalid Solana token address', {
        address: responseContent?.recommend_sell_address,
      });
      return false;
    }
    console.log('sell-signal', responseContent);
    const params = responseContent;
    const signal: SellSignalMessage = {
      positionId: uuidv4() as UUID,
      tokenAddress: params.recommend_sell_address,
      amount: params.sell_amount,
      entityId: 'default',
      slippage: params.slippage || 100,
    };

    const token = goodAfTokens.find((t) => t.id === params.recommend_sell_address);
    if (!token) {
      logger.log(params.recommend_sell_address, 'not a auto.fun token');
      return false;
    }
    //console.log('token', token)
    console.log('is AF token');

    if (token.status === 'migrated' || token.status === 'locked') {
      await this.updateExpectedOutAmount(signal);
    }

    const tokenBalance = walletData.find((a) => a.mint === params.recommend_sell_address).balance;
    /*
    console.log('getting balance');

    const tokenBalance = await getTokenBalance(this.runtime, signal.tokenAddress);
    if (!tokenBalance) {
      logger.log('No token balance found');
      return { success: false, error: 'No token balance found' };
    }
    */

    console.log('got balance', tokenBalance);

    //.times(10 ** tokenBalance.decimals)
    const sellAmount = toBN(signal.amount).times(10 ** 3);
    if (sellAmount.gt(toBN(tokenBalance.balance))) {
      logger.log(
        `Insufficient token balance. Requested: ${sellAmount.toString()}, Available: ${tokenBalance.balance}`
      );
      return {
        success: false,
        error: `Insufficient token balance. Requested: ${sellAmount.toString()}, Available: ${tokenBalance.balance}`,
      };
    }

    this.pendingSells[signal.tokenAddress] = (
      this.pendingSells[signal.tokenAddress] || toBN(0)
    ).plus(sellAmount);

    const slippageBps = await this.calculationService.calculateDynamicSlippage(
      signal.tokenAddress,
      Number(sellAmount),
      true
    );
    signal.amount = sellAmount;

    console.log('sellAmount', sellAmount, 'slippageBps', slippageBps);

    let result = {};
    if (token.status === 'migrated' || token.status === 'locked') {
      logger.debug('selling from LP (bonded)');

      /*
      result = await executeTrade(this.runtime, {
        tokenAddress: signal.tokenAddress,
        amount: sellAmount.toString(),
        slippage: slippageBps,
        dex: 'jup',
        action: 'SELL',
      });
      */
      /*
      result = await wallet.sell({
        tokenAddress: signal.tokenAddress,
        amountInSol: buyAmount,
        slippageBps,
      });
      */
    } else {
      logger.debug('selling from AutoFun (unbonded)');
      await this.autofunSell(signal, slippageBps);
    }

    if (result.success) {
      await this.tradeMemoryService.createTrade({
        tokenAddress: signal.tokenAddress,
        chain: 'solana',
        type: 'SELL',
        amount: sellAmount.toString(),
        price: token.currentPrice.toString(),
        txHash: result.signature,
        metadata: {
          slippage: slippageBps,
          expectedAmount: signal.expectedOutAmount || '0',
          receivedAmount: result.receivedAmount || '0',
          valueUsd: result.receivedValue || '0',
        },
      });

      await this.analyticsService.trackSlippageImpact(
        signal.tokenAddress,
        signal.expectedOutAmount || '0',
        result.receivedAmount || '0',
        slippageBps,
        true
      );
    }

    return result;
  }

  private async updateExpectedOutAmount(
    signal: SellSignalMessage & { expectedOutAmount?: string }
  ): Promise<void> {
    if (!signal.amount) return;

    try {
      const quoteResponse = await fetch(
        `https://quote-api.jup.ag/v6/quote?inputMint=${
          signal.tokenAddress
        }&outputMint=So11111111111111111111111111111111111111112&amount=${Math.round(
          Number(signal.amount) * 1e9
        )}&slippageBps=${signal.slippage || 100}`
      );

      if (quoteResponse.ok) {
        const quoteData = await quoteResponse.json();
        signal.expectedOutAmount = quoteData.outAmount;
      }
    } catch (error) {
      logger.warn('Failed to get expected out amount for sell', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async autofunSell(signal, slippageBps) {
    const wallet = await this.walletService.getWallet();
    // for anchor
    const walletAdapter = {
      publicKey: wallet.publicKey,
      signTransaction: async <T extends Transaction | VersionedTransaction>(tx: T): Promise<T> => {
        await wallet.executeTrade({
          tokenAddress: signal.tokenAddress,
          amount: signal.amount,
          slippage: slippageBps,
          action: 'SELL',
        });
        return tx;
      },
      signAllTransactions: async <T extends Transaction | VersionedTransaction>(
        txs: T[]
      ): Promise<T[]> => {
        return Promise.all(txs.map((tx) => walletAdapter.signTransaction(tx)));
      },
    };

    const connection = new Connection(this.runtime.getSetting('SOLANA_RPC_URL'));

    const provider = new AnchorProvider(connection, walletAdapter, AnchorProvider.defaultOptions());
    // Use the imported IDL for typing, cast to any to bypass potential strict type mismatch
    const program = new Program<Autofun>(IDL, provider);

    const tokenAddress = signal.tokenAddress;

    const [bondingCurvePda] = PublicKey.findProgramAddressSync(
      [Buffer.from('bonding_curve'), new PublicKey(tokenAddress).toBytes()],
      program.programId
    );

    const curve = await program.account.bondingCurve.fetch(bondingCurvePda);

    const [configPda, _] = PublicKey.findProgramAddressSync(
      [Buffer.from('config')],
      program.programId
    );

    const config = await program.account.config.fetch(configPda);

    // is this right?
    const amount = parseFloat(signal.amount) * 1e3;

    const internalIx = await swapIx(
      wallet.publicKey,
      new PublicKey(tokenAddress),
      amount,
      1,
      slippageBps,
      program,
      curve.reserveToken.toNumber(),
      curve.reserveLamport.toNumber(),
      config
    );
    let ixs: any[] = [internalIx];
    const solFee = 0.0005;
    const feeLamports = Math.floor(solFee * 1e9);
    ixs.push(
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: feeLamports,
      })
    );
    const tx = new Transaction().add(...ixs);
    const { blockhash } = await connection.getLatestBlockhash();
    tx.feePayer = wallet.publicKey;
    tx.recentBlockhash = blockhash;

    console.log('Executing sell simulation transaction...');
    const simulation = await connection.simulateTransaction(tx);
    if (simulation.value.err) {
      logger.error('Sell transaction simulation failed:', simulation.value.err);
      logger.error('Sell simulation Logs:', simulation.value.logs);
      return {
        success: false,
        signature: '',
        outAmount: 0,
        swapUsdValue: 0,
      };
    } else {
      logger.log('Sell transaction simulation successful.');
    }
    const versionedTx = new VersionedTransaction(tx.compileMessage());

    const walletKeypair = this.walletService.keypair;

    // Get fresh blockhash with processed commitment for speed
    const latestBlockhash = await connection.getLatestBlockhash('processed');
    versionedTx.message.recentBlockhash = latestBlockhash.blockhash;
    versionedTx.sign([walletKeypair]);

    // Send transaction
    const signature = await connection.sendRawTransaction(versionedTx.serialize(), {
      skipPreflight: true,
      maxRetries: 5,
      preflightCommitment: 'processed',
    });
    console.log(`Standard transaction sent, signature: ${signature}`);

    let success = false;
    success = true;
    return {
      success,
      signature,
      outAmount: 0,
      swapUsdValue: 0,
    };
  }

  public async executeSell(signal: SellSignalMessage & { expectedOutAmount?: string }): Promise<{
    success: boolean;
    signature?: string;
    error?: string;
    receivedAmount?: string;
    receivedValue?: string;
  }> {
    try {
      if (!signal) {
        throw new Error('No signal data in sell task');
      }

      const tokenBalance = await getTokenBalance(this.runtime, signal.tokenAddress);
      if (!tokenBalance) {
        return { success: false, error: 'No token balance found' };
      }

      const sellAmount = toBN(signal.amount).times(10 ** tokenBalance.decimals);
      if (sellAmount.gt(toBN(tokenBalance.balance))) {
        return {
          success: false,
          error: `Insufficient token balance. Requested: ${sellAmount.toString()}, Available: ${tokenBalance.balance}`,
        };
      }

      try {
        this.pendingSells[signal.tokenAddress] = (
          this.pendingSells[signal.tokenAddress] || toBN(0)
        ).plus(sellAmount);

        const slippageBps = await this.calculationService.calculateDynamicSlippage(
          signal.tokenAddress,
          Number(sellAmount),
          true
        );

        // Add validation for slippage with warning and enforce stricter limits
        /*
        const MAX_SLIPPAGE_BPS = 1000; // 10% max slippage
        const MIN_SLIPPAGE_BPS = 10; // 0.1% min slippage
        const validatedSlippage = Math.min(
          Math.max(
            Math.floor(slippageBps),
            MIN_SLIPPAGE_BPS
          ),
          MAX_SLIPPAGE_BPS
        );

        if (validatedSlippage !== slippageBps) {
          logger.warn('Slippage value adjusted', {
            original: slippageBps,
            adjusted: validatedSlippage,
            tokenAddress: signal.tokenAddress,
            reason: 'Value outside safe bounds'
          });
        }
        */

        const result = await executeTrade(this.runtime, {
          tokenAddress: signal.tokenAddress,
          amount: sellAmount.toString(),
          slippage: slippageBps,
          dex: 'jup',
          action: 'SELL',
        });

        // why are we getting this after the trade execution?
        // for the price? shouldn't we already have it?
        const marketData = await this.dataService.getTokenMarketData(signal.tokenAddress);
        //console.log('sell marketData', marketData)

        if (result.success) {
          await this.tradeMemoryService.createTrade({
            tokenAddress: signal.tokenAddress,
            chain: 'solana',
            type: 'SELL',
            amount: sellAmount.toString(),
            price: marketData.priceUsd.toString(),
            txHash: result.signature,
            metadata: {
              slippage: slippageBps,
              expectedAmount: signal.expectedOutAmount || '0',
              receivedAmount: result.receivedAmount || '0',
              valueUsd: result.receivedValue || '0',
            },
          });

          await this.analyticsService.trackSlippageImpact(
            signal.tokenAddress,
            signal.expectedOutAmount || '0',
            result.receivedAmount || '0',
            slippageBps,
            true
          );
        }

        return result;
      } finally {
        this.pendingSells[signal.tokenAddress] = (
          this.pendingSells[signal.tokenAddress] || toBN(0)
        ).minus(sellAmount);
        if (this.pendingSells[signal.tokenAddress].lte(toBN(0))) {
          delete this.pendingSells[signal.tokenAddress];
        }
      }
    } catch (error) {
      logger.error('Error executing sell task:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}
