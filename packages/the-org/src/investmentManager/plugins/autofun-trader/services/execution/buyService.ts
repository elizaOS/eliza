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
import { BuySignalMessage } from '../../types';
import { v4 as uuidv4 } from 'uuid';
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

interface IBuySignalOutput {
  recommended_buy: string;
  recommend_buy_address: string;
  reason: string;
  buy_amount: string | number;
}

interface ConfigAccount {
  teamWallet: PublicKey;
  platformSellFee: number;
  platformBuyFee: number;
}

interface BuySignalMessage {
  positionId: UUID;
  tokenAddress: string;
  entityId: string;
  tradeAmount: string | number;
  expectedOutAmount: string;
}

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
      6, // SOL decimals (why is this different)
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

// Only choose a token that occurs in both the Trending Tokens list as well as the Sentiment analysis. This ensures we have the proper token address.
// The sentiment score has a range of -100 to 100, with -100 indicating extreme negativity and 100 indicating extreme positiveness.

const buyTemplate = `
I want you to give a crypto buy signal based on both the sentiment analysis as well as the trending tokens.
You trade on auto.fun, a token launchpad, a lot of these coins are brand new, won't have a lot of history.
Be hesitant about imported coins, you're more interested in the prebonded tokens.
My current balance is {{solana_balance}} SOL, If I have less than 0.3 SOL then I should not buy unless it's really good opportunity.
Also let me know what a good amount would be to buy. Buy amount should at least be 0.05 SOL and maximum 0.25 SOL.

Sentiment analysis:

{{sentiment}}

Tokens:

{{tokens}}

Only return the following JSON:

{
recommended_buy: "the symbol of the token for example DEGENAI",
recommend_buy_address: "the address of the token to purchase, for example: 2sCUCJdVkmyXp4dT8sFaA9LKgSMK4yDPi9zLHiwXpump",
reason: "the reason why you think this is a good buy, and why you chose the specific amount",
buy_amount: "number, for example: 0.1",
sell_price: "number for what you think a good exit price is for example: 0.1"
}
Do not include any text after the JSON
`;

export class BuyService extends BaseTradeService {
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
    logger.info('Initializing buy service');
    this.runtime.registerEvent('SPARTAN_TRADE_BUY_SIGNAL', this.handleBuySignal.bind(this));
  }

  async stop(): Promise<void> {
    // Cleanup if needed
  }

  async generateSignal() {
    console.log('buy-signal - start');
    // get data from plugin-auto
    //const tradeService = runtime.getService(ServiceTypes.AUTOFUN_TRADING)
    // or make call ourself
    const url =
      'https://api.auto.fun/api/tokens?limit=1000&page=1&sortBy=createdAt&sortOrder=desc&hideImported=1';
    const res = await fetch(url);
    const data = await res.json();

    /*
  page: 1,
  totalPages: 7,
  total: 1207,
  hasMore: true,
*/

    console.log('buy-signal - got token data', data.tokens.length);
    if (!data.tokens?.length) {
      logger.warn('buy-signal - no autofun response');
      return false;
    }

    // inject into prompt
    let prompt = buyTemplate;
    prompt = prompt.replace('{{sentiment}}', 'The highly technical analysis is: buy whatever dude');

    let latestTxt =
      '\nCurrent Auto.fun list of all active cryptocurrencies with latest market data:\n';
    let idx = 1;
    const fields = [
      'id',
      'name',
      'ticker',
      'url', // seems to be metadata url
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
      'status',
    ];
    const remaps = {
      ticker: 'symbol',
    };
    latestTxt +=
      'id, name, symbol, url, twitter, telegram, discord, farcaster, description, liquidity, currentPrice, tokenSupplyUiAmount, holderCount, volume24h, price24hAgo, priceChange24h, curveProgress, status';
    latestTxt += '\n';
    for (const t of data.tokens) {
      const out = [];
      for (const f of fields) {
        let val = t[f];
        if (val?.replaceAll) {
          val = val.replaceAll('\n', ' ');
        }
        out.push(val);
      }
      latestTxt += out.join(', ') + '\n';
    }

    prompt = prompt.replace('{{tokens}}', latestTxt);

    // get balance from plugin-solana
    const walletBalance = await this.walletService.getBalance();
    prompt = prompt.replace('{{solana_balance}}', walletBalance);

    // run llm call
    let responseContent: IBuySignalOutput | null = null;
    // Retry if missing required fields
    let retries = 0;
    const maxRetries = 3;
    // recommended_buy, recommend_buy_address, reason, buy_amount
    while (
      retries < maxRetries &&
      (!responseContent?.recommended_buy ||
        !responseContent?.reason ||
        !responseContent?.recommend_buy_address)
    ) {
      // could use OBJECT_LARGE but this expects a string return type rn
      // not sure where OBJECT_LARGE does it's parsing...
      const response = await this.runtime.useModel(ModelType.TEXT_LARGE, {
        prompt,
        system: 'You are a buy signal analyzer.',
        temperature: 0.2,
        maxTokens: 4096,
        object: true,
      });

      console.log('afTrader:buy-signal - response', response);
      responseContent = parseJSONObjectFromText(response) as IBuySignalOutput;

      retries++;
      if (
        !responseContent?.recommended_buy &&
        !responseContent?.reason &&
        !responseContent?.recommend_buy_address
      ) {
        logger.warn('*** Missing required fields, retrying... generateSignal ***');
      }
    }

    if (!responseContent?.recommend_buy_address) {
      console.warn('afTrader:buy-signal::generateSignal - no buy recommendation');
      return false;
    }

    if (!responseContent?.recommend_buy_address?.match(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)) {
      logger.error('Invalid Solana token address', {
        address: responseContent?.recommend_buy_address,
      });
      return false;
    }
    //const walletBalance = await this.walletService.getBalance();

    // what type of token is this, prebonded or post-bonded?

    const params = responseContent;
    //console.log('buy params', params);
    const signal: BuySignalMessage = {
      positionId: uuidv4() as UUID,
      tokenAddress: params.recommend_buy_address,
      entityId: 'default',
      tradeAmount: params.buy_amount,
      expectedOutAmount: '0',
    };
    console.log('buy signal', signal);

    const token = data.tokens.find((t) => t.id === params.recommend_buy_address);
    if (!token) {
      console.log(params.recommend_buy_address, 'not a auto.fun token');
      return false;
    }
    //console.log('token', token)

    await this.updateExpectedOutAmount(signal);

    const buyAmount = await this.calculationService.calculateOptimalBuyAmount({
      tokenAddress: signal.tokenAddress,
      walletBalance,
      signal,
    });

    if (buyAmount <= 0) {
      return { success: false, error: 'Buy amount too small' };
    }

    const slippageBps = await this.calculationService.calculateDynamicSlippage(
      signal.tokenAddress,
      buyAmount,
      false
    );

    signal.tradeAmount = buyAmount;
    const wallet = await this.walletService.getWallet();

    let result = {};
    if (token.status === 'migrated' || token.status === 'locked') {
      logger.debug('buying from LP (bonded)');
      /*
      result = await wallet.buy({
        tokenAddress: signal.tokenAddress,
        amountInSol: buyAmount,
        slippageBps,
      });
      */
    } else {
      logger.debug('buying from AutoFun (unbonded)');
      await this.autofunBuy(wallet, signal, slippageBps);
    }

    if (result.success) {
      await this.tradeMemoryService.createTrade({
        tokenAddress: signal.tokenAddress,
        chain: 'solana',
        type: 'BUY',
        amount: buyAmount.toString(),
        price: token.currentPrice.toString(),
        txHash: result.signature,
        metadata: {
          slippage: slippageBps,
          expectedAmount: signal.expectedOutAmount,
          receivedAmount: result.outAmount,
          valueUsd: result.swapUsdValue,
        },
      });

      if (result.outAmount) {
        await this.analyticsService.trackSlippageImpact(
          signal.tokenAddress,
          signal.expectedOutAmount || '0',
          result.outAmount,
          slippageBps,
          false
        );
      }
    }
  }

  private async autofunBuy(wallet, signal, slippageBps) {
    // for anchor
    const walletAdapter = {
      publicKey: wallet.publicKey,
      signTransaction: async <T extends Transaction | VersionedTransaction>(tx: T): Promise<T> => {
        await wallet.executeTrade({
          tokenAddress: signal.tokenAddress,
          amount: buyAmount,
          slippage: slippageBps,
          action: 'BUY',
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
    const amount = parseFloat(signal.tradeAmount) * 1e3;

    const internalIx = await swapIx(
      wallet.publicKey,
      new PublicKey(tokenAddress),
      amount,
      0,
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

    console.log('Executing buy simulation transaction...');
    const simulation = await connection.simulateTransaction(tx);
    if (simulation.value.err) {
      logger.error('Buy transaction simulation failed:', simulation.value.err);
      logger.error('Buy simulation Logs:', simulation.value.logs);
      return {
        success: false,
        signature: '',
        outAmount: 0,
        swapUsdValue: 0,
      };
    }
    logger.log('Buy transaction simulation successful.');

    const versionedTx = new VersionedTransaction(tx.compileMessage());

    //const walletKeypair = getWalletKeypair(runtime);
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

    //signature = await wallet.sendTransaction(versionedTx, connection);
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

  private async handleBuySignal(params: any): Promise<void> {
    const TRADER_BUY_KUMA = this.runtime.getSetting('TRADER_BUY_KUMA');
    if (TRADER_BUY_KUMA) {
      fetch(TRADER_BUY_KUMA).catch((e) => {
        logger.error('TRADER_BUY_KUMA err', e);
      });
    }

    const signal: BuySignalMessage = {
      positionId: uuidv4() as UUID,
      tokenAddress: params.recommend_buy_address,
      entityId: 'default',
      tradeAmount: params.buy_amount,
      expectedOutAmount: '0',
    };

    await this.updateExpectedOutAmount(signal);
    this.executeBuy(signal).then((result) => {
      logger.info('executeBuy - result', result);
    });
  }

  private async updateExpectedOutAmount(signal: BuySignalMessage): Promise<void> {
    if (!signal.tradeAmount) return;

    try {
      const quoteResponse = await fetch(
        `https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${
          signal.tokenAddress
        }&amount=${Math.round(Number(signal.tradeAmount) * 1e9)}&slippageBps=0`
      );

      if (quoteResponse.ok) {
        const quoteData = await quoteResponse.json();
        signal.expectedOutAmount = quoteData.outAmount;
      }
    } catch (error) {
      logger.warn('Failed to get expected out amount for buy', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async executeBuy(signal: BuySignalMessage) {
    const walletBalance = await this.walletService.getBalance();

    const buyAmount = await this.calculationService.calculateOptimalBuyAmount({
      tokenAddress: signal.tokenAddress,
      walletBalance,
      signal,
    });

    if (buyAmount <= 0) {
      return { success: false, error: 'Buy amount too small' };
    }

    const slippageBps = await this.calculationService.calculateDynamicSlippage(
      signal.tokenAddress,
      buyAmount,
      false
    );

    return await this.walletService.buy({
      tokenAddress: signal.tokenAddress,
      amountInSol: buyAmount,
      slippageBps,
    });
  }
}
