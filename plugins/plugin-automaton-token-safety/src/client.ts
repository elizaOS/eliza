/**
 * x402 v2 client for the Automaton routes. Same flow and guards as the kit's lib/x402-client.js:
 * on 402 pick the exact / eip155:8453 / USDC requirement, refuse anything above `maxAmountUnits`,
 * to another payTo or network, then ask the INJECTED signer for one EIP-712
 * TransferWithAuthorization (EIP-3009) and retry with the payment header. The CDP facilitator
 * settles and sponsors gas. This client never holds key material and never sends a transaction.
 */
import { randomBytes } from 'node:crypto';
import { ROUTES, DEFAULT_BASE_URL, NETWORK, USDC_BASE, AUTOMATON_PAY_TO, type RouteId } from './routes.js';

export interface TypedDataSigner {
  address: string;
  signTypedData(domain: Record<string, unknown>, types: Record<string, Array<{ name: string; type: string }>>, message: Record<string, unknown>): Promise<string>;
}

export interface CallResult {
  status: number;
  paid: boolean;
  dryRun?: boolean;
  amountUnits?: string;
  data?: unknown;
  paymentHeader?: string;
}

export const TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' }
  ]
};

export class GuardError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

interface Requirement {
  scheme: string; network: string; asset: string; payTo: string;
  amount?: string; maxAmountRequired?: string; maxTimeoutSeconds?: number;
  extra?: { name?: string; version?: string };
}

export interface ClientOptions {
  baseUrl?: string;
  signer?: TypedDataSigner | null;
  maxAmountUnits?: number;
  allowedPayTo?: string[];
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const safeJson = (t: string): unknown => { try { return JSON.parse(t); } catch { return t; } };
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64');

export function createX402Client(opts: ClientOptions = {}) {
  const base = (opts.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const signer = opts.signer || null;
  const maxAmountUnits = BigInt(opts.maxAmountUnits ?? 10000);
  const allowed = (opts.allowedPayTo || [AUTOMATON_PAY_TO]).map((a) => a.toLowerCase());
  const doFetch = opts.fetchImpl || fetch;
  const now = opts.now || Date.now;

  function request(route: RouteId, input: Record<string, unknown>, headers: Record<string, string> = {}) {
    const def = ROUTES[route];
    if (def.method === 'GET') {
      const qs = new URLSearchParams(Object.entries(input).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));
      return doFetch(base + def.path + (qs.toString() ? '?' + qs.toString() : ''), { method: 'GET', headers });
    }
    return doFetch(base + def.path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(input) });
  }

  function pick(challenge: { accepts?: Requirement[] } | null): { req: Requirement; amount: bigint } {
    const req = (challenge?.accepts || []).find((a) => a && a.scheme === 'exact' && a.network === NETWORK && String(a.asset).toLowerCase() === USDC_BASE.toLowerCase());
    if (!req) throw new GuardError('no_supported_requirement', 'challenge has no exact / eip155:8453 / USDC requirement');
    const amount = BigInt(req.amount || req.maxAmountRequired || '0');
    if (amount <= 0n) throw new GuardError('bad_amount', 'requirement amount is not positive');
    if (amount > maxAmountUnits) throw new GuardError('amount_above_cap', `requirement ${amount} units exceeds cap ${maxAmountUnits}`);
    if (!allowed.includes(String(req.payTo).toLowerCase())) throw new GuardError('payto_not_allowed', `payTo ${req.payTo} is not allowed`);
    return { req, amount };
  }

  async function call(route: RouteId, input: Record<string, unknown>, { dryRun = false } = {}): Promise<CallResult> {
    const first = await request(route, input);
    const firstText = await first.text();
    if (first.status !== 402) return { status: first.status, paid: false, data: safeJson(firstText) };
    if (!signer) throw new GuardError('no_signer', 'payment required but no signer was configured');

    const hdr = first.headers.get('payment-required');
    const challenge = (hdr ? safeJson(Buffer.from(hdr, 'base64').toString('utf8')) : safeJson(firstText)) as { accepts?: Requirement[]; extensions?: { bazaar?: unknown } } | null;
    const { req, amount } = pick(challenge);
    const t = Math.floor(now() / 1000);
    const authorization = {
      from: signer.address, to: req.payTo, value: amount.toString(),
      validAfter: String(t - 60), validBefore: String(t + Number(req.maxTimeoutSeconds || 60)),
      nonce: '0x' + randomBytes(32).toString('hex')
    };
    const domain = { name: req.extra?.name || 'USD Coin', version: req.extra?.version || '2', chainId: 8453, verifyingContract: req.asset };
    const signature = await signer.signTypedData(domain, TYPES, authorization);
    const paymentPayload: Record<string, unknown> = { x402Version: 2, accepted: req, payload: { signature, authorization } };
    if (challenge?.extensions?.bazaar) paymentPayload.extensions = { bazaar: challenge.extensions.bazaar };
    const header = b64(paymentPayload);
    if (dryRun) return { status: 402, paid: false, dryRun: true, amountUnits: amount.toString(), paymentHeader: header };

    const second = await request(route, input, { 'X-PAYMENT': header, 'PAYMENT-SIGNATURE': header });
    const text = await second.text();
    return { status: second.status, paid: second.status === 200, amountUnits: amount.toString(), data: safeJson(text) };
  }

  return { call };
}

/** Signer from an operator-supplied key string (setting AUTOMATON_SIGNER_KEY). Needs `ethers` v6. */
export async function signerFromKey(key: string): Promise<TypedDataSigner> {
  let ethers: typeof import('ethers');
  try { ethers = await import('ethers'); } catch { throw new Error('ethers v6 is required to sign x402 payments (npm i ethers)'); }
  const w = new ethers.Wallet(key.trim());
  return { address: w.address, signTypedData: (d, t, m) => w.signTypedData(d, t, m) };
}
