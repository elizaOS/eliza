/**
 * Stellar x402 Payment Adapter
 *
 * Implements x402 payment protocol on Stellar network.
 * Stellar x402 support went live March 11, 2026.
 *
 * Chain identifiers:
 *   - Stellar Mainnet: "stellar:pubnet"
 *   - Stellar Testnet: "stellar:testnet"
 *
 * Key differences from EVM chains:
 * - Uses Ed25519 keypairs (not secp256k1)
 * - Transaction format: Stellar XDR (not EVM tx)
 * - Settlement: ~5 seconds (1 ledger close)
 * - Fees: ~0.00001 XLM per operation (effectively free at scale)
 * - USDC: Circle-issued USDC on Stellar
 */

// ─── Stellar Chain Constants ─────────────────────────────────────────────────

export const STELLAR_NETWORK = {
  pubnet: {
    horizonUrl: 'https://horizon.stellar.org',
    networkPassphrase: 'Public Global Stellar Network ; September 2015',
    chainId: 'stellar:pubnet',
  },
  testnet: {
    horizonUrl: 'https://horizon-testnet.stellar.org',
    networkPassphrase: 'Test SDF Network ; September 2015',
    chainId: 'stellar:testnet',
  },
} as const;

/**
 * Circle USDC on Stellar (Mainnet)
 * Asset code: USDC
 * Issuer: GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN
 */
export const STELLAR_USDC = {
  pubnet: {
    code: 'USDC',
    issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
  },
  testnet: {
    code: 'USDC',
    issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  },
} as const;

// ─── Types ────────────────────────────────────────────────────────────────────

export type StellarNetwork = 'pubnet' | 'testnet';

export interface StellarPaymentConfig {
  /** Which Stellar network to use */
  network?: StellarNetwork;
  /** x402 resource identifier (for memo) */
  resource?: string;
  /** Custom Horizon URL (overrides default) */
  horizonUrl?: string;
}

export interface StellarPaymentRequest {
  /** Destination Stellar account (G... address) */
  destination: string;
  /** Amount in USDC (decimal string, e.g. "0.50") */
  amount: string;
  /** Source Stellar account public key */
  sourcePublicKey: string;
  /** x402 resource path for memo */
  resource?: string;
  /** Network to use */
  network?: StellarNetwork;
}

export interface StellarPaymentResult {
  /** Stellar transaction hash */
  hash: string;
  /** Ledger number the transaction landed in */
  ledger: number;
  /** Successful */
  successful: boolean;
  /** Network used */
  network: StellarNetwork;
}

// ─── Stellar x402 Payment Adapter ────────────────────────────────────────────

/**
 * StellarX402Adapter
 *
 * Handles x402 payment flow for Stellar network.
 *
 * Usage (with stellar-sdk):
 * ```typescript
 * import { StellarX402Adapter } from 'agentwallet-sdk/x402/stellar';
 * import { Keypair, Networks } from '@stellar/stellar-sdk';
 *
 * const adapter = new StellarX402Adapter({ network: 'pubnet' });
 * const result = await adapter.pay({
 *   destination: 'GDESTWVX3VMLQCXPHPVLS3FMNMG2X7L5IGGQT7BQMIZXZZ4V7KBQVS',
 *   amount: '0.50',
 *   sourcePublicKey: keypair.publicKey(),
 *   resource: '/api/data-endpoint',
 * }, keypair.secret());
 * ```
 *
 * Note: stellar-sdk must be installed separately:
 * npm install @stellar/stellar-sdk
 */
export class StellarX402Adapter {
  private network: StellarNetwork;
  private horizonUrl: string;

  constructor(config: StellarPaymentConfig = {}) {
    this.network = config.network ?? 'pubnet';
    this.horizonUrl = config.horizonUrl ?? STELLAR_NETWORK[this.network].horizonUrl;
  }

  /**
   * Parse an x402 402 response and extract Stellar payment details.
   * The 402 response should include X-Payment-Chains: stellar:pubnet
   * and X-Payment-Amount, X-Payment-Destination headers.
   */
  parseX402Response(headers: Record<string, string>): {
    supported: boolean;
    destination?: string;
    amount?: string;
    resource?: string;
  } {
    const chains = headers['x-payment-chains'] ?? headers['X-Payment-Chains'] ?? '';
    const chainId = STELLAR_NETWORK[this.network].chainId;

    if (!chains.includes(chainId) && !chains.includes('stellar')) {
      return { supported: false };
    }

    return {
      supported: true,
      destination: headers['x-payment-destination'] ?? headers['X-Payment-Destination'],
      amount: headers['x-payment-amount'] ?? headers['X-Payment-Amount'],
      resource: headers['x-payment-resource'] ?? headers['X-Payment-Resource'],
    };
  }

  /**
   * Build a Stellar USDC payment transaction.
   *
   * Requires @stellar/stellar-sdk to be installed:
   * npm install @stellar/stellar-sdk
   *
   * Returns the XDR-encoded transaction envelope for signing and submission.
   */
  async buildPaymentTransaction(request: StellarPaymentRequest): Promise<string> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let StellarSdk: any;
    try {
      // @ts-expect-error — @stellar/stellar-sdk is an optional peer dependency
      StellarSdk = await import('@stellar/stellar-sdk');
    } catch {
      throw new Error(
        'Stellar support requires @stellar/stellar-sdk: npm install @stellar/stellar-sdk'
      );
    }

    const networkConfig = STELLAR_NETWORK[request.network ?? this.network];
    const usdcAsset = STELLAR_USDC[request.network ?? this.network];

    // Load source account sequence number from Horizon
    const account = await this._loadAccount(request.sourcePublicKey, networkConfig.horizonUrl);

    const stellarAccount = new StellarSdk.Account(
      request.sourcePublicKey,
      account.sequence
    );

    const asset = new StellarSdk.Asset(usdcAsset.code, usdcAsset.issuer);

    const memoText = request.resource
      ? request.resource.slice(0, 28) // Stellar memo max 28 bytes
      : 'x402-payment';

    const transaction = new StellarSdk.TransactionBuilder(stellarAccount, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: networkConfig.networkPassphrase,
    })
      .addOperation(
        StellarSdk.Operation.payment({
          destination: request.destination,
          asset,
          amount: request.amount,
        })
      )
      .addMemo(StellarSdk.Memo.text(memoText))
      .setTimeout(300) // 5 minute window
      .build();

    return transaction.toXDR();
  }

  /**
   * Submit a signed Stellar transaction to Horizon.
   */
  async submitTransaction(signedXdr: string): Promise<StellarPaymentResult> {
    const networkConfig = STELLAR_NETWORK[this.network];

    const body = new URLSearchParams({ tx: signedXdr }).toString();
    const resp = await fetch(`${networkConfig.horizonUrl}/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Stellar transaction failed: ${resp.status} ${err.slice(0, 200)}`);
    }

    const result = await resp.json() as {
      hash: string;
      ledger: number;
      successful: boolean;
    };

    return {
      hash: result.hash,
      ledger: result.ledger,
      successful: result.successful ?? true,
      network: this.network,
    };
  }

  private async _loadAccount(
    publicKey: string,
    horizonUrl: string
  ): Promise<{ sequence: string }> {
    const resp = await fetch(`${horizonUrl}/accounts/${publicKey}`);
    if (!resp.ok) {
      throw new Error(
        `Cannot load Stellar account ${publicKey}: ${resp.status}. ` +
        `Ensure the account exists and has a USDC trustline established.`
      );
    }
    const data = await resp.json() as { sequence: string };
    return { sequence: data.sequence };
  }

  /** Chain ID for this adapter (e.g. "stellar:pubnet") */
  get chainId(): string {
    return STELLAR_NETWORK[this.network].chainId;
  }
}

// ─── x402 Auto-Pay Helper ────────────────────────────────────────────────────

/**
 * Full x402 payment flow for Stellar.
 * 1. Detects 402 response from API
 * 2. Parses Stellar payment details from headers
 * 3. Builds, signs, and submits Stellar USDC payment
 * 4. Retries the original request with payment proof
 *
 * Requires stellar-sdk: npm install @stellar/stellar-sdk
 */
export async function stellarX402Pay(params: {
  /** The 402 response headers */
  responseHeaders: Record<string, string>;
  /** Source account public key */
  sourcePublicKey: string;
  /** Signer function that takes XDR and returns signed XDR */
  sign: (xdr: string) => Promise<string>;
  /** Network to use */
  network?: StellarNetwork;
}): Promise<StellarPaymentResult> {
  const adapter = new StellarX402Adapter({ network: params.network ?? 'pubnet' });

  const details = adapter.parseX402Response(params.responseHeaders);
  if (!details.supported) {
    throw new Error('This endpoint does not support Stellar x402 payments');
  }
  if (!details.destination || !details.amount) {
    throw new Error('x402 response missing destination or amount headers');
  }

  const xdr = await adapter.buildPaymentTransaction({
    destination: details.destination,
    amount: details.amount,
    sourcePublicKey: params.sourcePublicKey,
    resource: details.resource,
    network: params.network ?? 'pubnet',
  });

  const signedXdr = await params.sign(xdr);
  return adapter.submitTransaction(signedXdr);
}
