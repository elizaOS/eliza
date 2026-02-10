import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from '@elizaos/core';
import { logger } from '@elizaos/core';
import { createWalletClient, http, type Hex } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { getSignetConfig, getPrivateKey } from '../config.ts';

/** USDC contract on Base mainnet. */
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const;

/** Default EIP-712 domain for USDC on Base (EIP-3009). */
const DEFAULT_USDC_DOMAIN = {
  name: 'USD Coin',
  version: '2',
  chainId: 8453,
  verifyingContract: USDC_ADDRESS,
} as const;

/** EIP-3009 TransferWithAuthorization typed data types. */
const TRANSFER_AUTH_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

/** Shape of the x402 payment requirements returned by Signet. */
interface PaymentRequirements {
  x402Version?: number;
  scheme?: string;
  network: string;
  amount: string;
  payTo: string;
  extra?: {
    eip712Domain?: {
      name: string;
      version: string;
      chainId: number;
      verifyingContract: string;
    };
  };
}

/** Generate a cryptographically random bytes32 nonce. */
function randomNonce(): Hex {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return ('0x' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')) as Hex;
}

/**
 * SIGNET_POST_SPOTLIGHT — Pay USDC via x402 to place a URL on the Signet spotlight.
 *
 * Flow:
 * 1. POST to /api/x402/spotlight → receive 402 with payment requirements
 * 2. Sign EIP-3009 transferWithAuthorization for the required USDC amount
 * 3. Resend request with X-PAYMENT header containing the signed authorization
 * 4. Signet settles the payment and executes the onchain Zap
 */
export const postSpotlightAction: Action = {
  name: 'SIGNET_POST_SPOTLIGHT',
  similes: [
    'POST_AD',
    'BUY_SPOTLIGHT',
    'SIGNET_ADVERTISE',
    'PROMOTE_ON_SIGNET',
    'PLACE_AD',
    'BUY_SIGNET_AD',
  ],
  description:
    'Post a URL to the Signet onchain spotlight by paying USDC on Base via x402. ' +
    'Requires a configured EVM private key with USDC balance.',

  validate: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined
  ): Promise<boolean> => {
    return getPrivateKey(runtime) !== null;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    _options: unknown,
    callback?: HandlerCallback,
    _responses?: Memory[]
  ): Promise<ActionResult> => {
    const sendError = async (msg: string): Promise<ActionResult> => {
      if (callback) {
        await callback({
          text: msg,
          actions: ['SIGNET_POST_SPOTLIGHT'],
          source: message.content.source,
        });
      }
      return { text: msg, success: false, error: new Error(msg) };
    };

    try {
      const config = getSignetConfig(runtime);
      const text = message.content.text || '';

      // --- Extract URL from message ---
      const urlMatch = text.match(/https?:\/\/[^\s)>\]]+/);
      if (!urlMatch) {
        return sendError(
          '❌ Please provide a URL to promote. Example: "Post https://myapp.com on Signet spotlight"'
        );
      }
      const targetUrl = urlMatch[0];

      // --- Extract guarantee hours ---
      const hoursMatch = text.match(/(\d+)\s*hour/i);
      const guaranteeHours = hoursMatch
        ? Math.min(Math.max(parseInt(hoursMatch[1], 10), 0), 24)
        : 0;

      // --- Resolve wallet ---
      const privateKey = getPrivateKey(runtime);
      if (!privateKey) {
        return sendError('❌ No private key configured for x402 payments.');
      }

      const account = privateKeyToAccount(privateKey as Hex);
      const walletClient = createWalletClient({
        account,
        chain: base,
        transport: http(config.rpcUrl),
      });

      // --- Step 1: Request payment requirements (402) ---
      const spotlightUrl = `${config.baseUrl}/api/x402/spotlight`;
      const body = JSON.stringify({ url: targetUrl, guaranteeHours });

      logger.info(
        { targetUrl, guaranteeHours, wallet: account.address },
        'Signet: initiating x402 spotlight purchase'
      );

      const initialRes = await fetch(spotlightUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });

      if (initialRes.ok) {
        // Unexpected success without payment — handle gracefully
        const result = await initialRes.json();
        const response = `✅ Spotlight posted! TX: \`${result.txHash}\``;
        if (callback) {
          await callback({
            text: response,
            actions: ['SIGNET_POST_SPOTLIGHT'],
            source: message.content.source,
          });
        }
        return { text: response, success: true, data: result };
      }

      if (initialRes.status !== 402) {
        throw new Error(
          `Expected 402 Payment Required, got ${initialRes.status}: ${await initialRes.text()}`
        );
      }

      // --- Step 2: Parse payment requirements ---
      const paymentData = await initialRes.json();
      const req: PaymentRequirements = Array.isArray(paymentData)
        ? paymentData[0]
        : paymentData;

      if (!req?.network || !req?.amount || !req?.payTo) {
        throw new Error('Invalid payment requirements from Signet');
      }

      logger.info(
        { amount: req.amount, payTo: req.payTo, network: req.network },
        'Signet: payment requirements received'
      );

      // --- Step 3: Sign EIP-3009 transferWithAuthorization ---
      const amount = BigInt(req.amount);
      const validAfter = 0n;
      const validBefore = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const nonce = randomNonce();

      const domain = req.extra?.eip712Domain || DEFAULT_USDC_DOMAIN;

      const signature = await walletClient.signTypedData({
        domain: {
          name: domain.name,
          version: domain.version,
          chainId: BigInt(domain.chainId),
          verifyingContract: domain.verifyingContract as Hex,
        },
        types: TRANSFER_AUTH_TYPES,
        primaryType: 'TransferWithAuthorization',
        message: {
          from: account.address,
          to: req.payTo as Hex,
          value: amount,
          validAfter,
          validBefore,
          nonce,
        },
      });

      // --- Step 4: Build x402 payment header and resend ---
      const paymentPayload = {
        x402Version: req.x402Version || 2,
        scheme: req.scheme || 'exact',
        network: req.network,
        payload: {
          signature,
          authorization: {
            from: account.address,
            to: req.payTo,
            value: amount.toString(),
            validAfter: validAfter.toString(),
            validBefore: validBefore.toString(),
            nonce,
          },
        },
      };

      const paymentHeader = btoa(JSON.stringify(paymentPayload));

      logger.info('Signet: submitting payment...');

      const paidRes = await fetch(spotlightUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-PAYMENT': paymentHeader,
        },
        body,
      });

      if (!paidRes.ok) {
        const errBody = await paidRes.text();
        throw new Error(`Payment settlement failed (${paidRes.status}): ${errBody}`);
      }

      const result = await paidRes.json();
      const costUSDC = (Number(amount) / 1e6).toFixed(2);

      const response = [
        '✅ **Spotlight Ad Posted on Signet!**',
        `• URL: ${targetUrl}`,
        `• Cost: $${costUSDC} USDC`,
        `• Guarantee: ${guaranteeHours}h`,
        `• TX: \`${result.txHash}\``,
        `• View: https://signet.sebayaki.com/signature/${result.signatureIndex}`,
      ].join('\n');

      if (callback) {
        await callback({
          text: response,
          actions: ['SIGNET_POST_SPOTLIGHT'],
          source: message.content.source,
        });
      }

      return { text: response, success: true, data: result };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error({ error: msg }, 'Signet: post spotlight failed');
      return sendError(`❌ Failed to post spotlight: ${msg}`);
    }
  },

  examples: [
    [
      {
        name: '{{userName}}',
        content: { text: 'Post https://myapp.xyz on Signet spotlight', actions: [] },
      },
      {
        name: '{{agentName}}',
        content: {
          text: '✅ **Spotlight Ad Posted on Signet!**\n• URL: https://myapp.xyz\n• Cost: $12.75 USDC\n• Guarantee: 0h\n• TX: `0xabc...`\n• View: https://signet.sebayaki.com/signature/127',
          actions: ['SIGNET_POST_SPOTLIGHT'],
        },
      },
    ],
    [
      {
        name: '{{userName}}',
        content: {
          text: 'Promote https://pizzaparty.fun on Signet with 6 hour guarantee',
          actions: [],
        },
      },
      {
        name: '{{agentName}}',
        content: {
          text: '✅ **Spotlight Ad Posted on Signet!**\n• URL: https://pizzaparty.fun\n• Cost: $45.20 USDC\n• Guarantee: 6h\n• TX: `0xdef...`\n• View: https://signet.sebayaki.com/signature/128',
          actions: ['SIGNET_POST_SPOTLIGHT'],
        },
      },
    ],
  ],
};
