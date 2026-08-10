// Raw Blockchair REST calls for Bitcoin data. Mirrors moralis.ts/helius.ts's
// structure: small typed fetch functions, no SDK dependency (fetch() only).
//
// Provider choice and pricing background: see the Bitcoin xpub design
// investigation (chain-expansion research) - Blockchair was picked over
// blockchain.info because blockchain.info's xpub-aware endpoint (multiaddr)
// only supports legacy xpub, live-confirmed to reject both SegWit (ypub)
// and native SegWit (zpub) test-vector keys outright with a 400 "invalid
// address" error - not degraded support, no support at all. Blockchair
// natively supports all three key formats via one dashboard endpoint.
//
// Free/keyless tier: Blockchair documents ~1,000 calls/day without an API
// key, but that tier is IP-pool-based and was live-confirmed unusable from
// at least one real environment - both the address and xpub dashboard
// endpoints returned HTTP 430 "Your IP address is temporary blacklisted due
// to exceeding usage of API resources" on the very first call, with no
// retry window that resolved it. Do not rely on the keyless tier working -
// BLOCKCHAIR_API_KEY is required in practice, not just recommended.
//
// Paid tier in use: the pay-as-you-go plan ($10 for 10,000 requests, valid
// 1 year, no recurring subscription - live-confirmed via Blockchair's own
// premium-plans page, not assumed), rather than the $25/mo subscription
// tier, since a one-time allotment matches this codebase's "stay free
// until revenue-validated" pattern for provider costs.
//
// Live-verified against a real address (12cbQLTFMXRnSzktFkuoG3eHoMeFtpTu3S,
// cross-checkable on any Bitcoin block explorer) and a real xpub
// (xpub6CUGRUonZSQ4TWtTMmzXdrXDtypWKiKrhko4egpiMZbpiaQL2jkwSB1icqYh2cfDfVxdx4df189oLKnC5fSwqPfgyP3hooxujYzAu3fDVmz)
// with the real BLOCKCHAIR_API_KEY - both dashboard endpoints confirmed
// working, response shapes below match the actual live payloads, not just
// Blockchair's docs.
//
// Blockchair does NOT validate address/xpub format server-side - a garbage
// string (live-confirmed: "not-a-real-bitcoin-address") returns HTTP 200
// with a valid-shaped but all-zero stub entry (balance 0, transaction_count
// 0, empty transactions/utxo), not an error. Callers that need to reject
// malformed input before spending a request on it should validate locally
// first (see isBitcoinAddress/isBitcoinXpub below) - Blockchair will not
// catch a typo for you. The data: null error path (BlockchairRequestError)
// is for real provider-side failures - live-confirmed via the IP-blacklist
// case encountered while testing the keyless tier above, which returned
// exactly that shape (HTTP 200, data: null, context.error populated).

const BLOCKCHAIR_BASE_URL = "https://api.blockchair.com/bitcoin";

function getBlockchairApiKey(): string {
  const apiKey = process.env.BLOCKCHAIR_API_KEY?.trim();

  if (!apiKey) {
    throw new Error(
      "Missing BLOCKCHAIR_API_KEY environment variable",
    );
  }

  return apiKey;
}

// Thrown by callBlockchairRest on any non-ok response, or on a response
// whose top-level "data" is null (Blockchair's own error signal - e.g. the
// IP-blacklist case returns HTTP 200 with data: null and the real error in
// context.error, not a non-2xx status).
export class BlockchairRequestError extends Error {
  readonly status: number;
  readonly blockchairMessage: string | null;

  constructor(status: number, blockchairMessage: string | null) {
    super(
      blockchairMessage
        ? `Blockchair request failed with status ${status}: ${blockchairMessage}`
        : `Blockchair request failed with status ${status}`,
    );
    this.name = "BlockchairRequestError";
    this.status = status;
    this.blockchairMessage = blockchairMessage;
  }
}

type BlockchairContext = {
  error?: string;
  code?: number;
  request_cost?: number;
};

type BlockchairEnvelope<T> = {
  data: T | null;
  context?: BlockchairContext;
};

async function callBlockchairRest<T>(
  path: string,
  searchParams: Record<string, string> = {},
): Promise<T> {
  const apiKey = getBlockchairApiKey();

  const url = new URL(`${BLOCKCHAIR_BASE_URL}${path}`);

  for (const [key, value] of Object.entries(searchParams)) {
    url.searchParams.set(key, value);
  }

  url.searchParams.set("key", apiKey);

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    let blockchairMessage: string | null = null;

    try {
      const body = (await response.json()) as { context?: BlockchairContext };
      blockchairMessage = body.context?.error ?? null;
    } catch {
      // Body wasn't JSON (or was empty) - fall back to status-only.
    }

    throw new BlockchairRequestError(response.status, blockchairMessage);
  }

  const envelope = (await response.json()) as BlockchairEnvelope<T>;

  // Blockchair signals real errors (rate limits, invalid input, IP
  // blacklisting) with HTTP 200 and data: null, not a non-2xx status - a
  // caller that only checked response.ok would silently treat these as
  // successful empty results.
  if (envelope.data === null) {
    throw new BlockchairRequestError(
      envelope.context?.code ?? response.status,
      envelope.context?.error ?? null,
    );
  }

  return envelope.data;
}

export type BlockchairAddressStats = {
  type?: string;
  balance?: number;
  balance_usd?: number;
  received?: number;
  spent?: number;
  output_count?: number;
  unspent_output_count?: number;
  first_seen_receiving?: string | null;
  last_seen_receiving?: string | null;
  first_seen_spending?: string | null;
  last_seen_spending?: string | null;
  transaction_count?: number;
};

// Only populated when the dashboard call passes transaction_details=true
// (always, below) - without it Blockchair returns bare tx-hash strings with
// no timestamp, which isn't enough to build a real transaction record.
// "time" is a "YYYY-MM-DD HH:MM:SS" UTC string (live-confirmed by parsing
// it as UTC and cross-checking the resulting date against a transaction
// known to have happened "today" relative to when this was verified) -
// not epoch seconds, callers must parse it themselves.
export type BlockchairTransactionSummary = {
  hash: string;
  block_id?: number;
  time?: string;
  balance_change?: number;
  // xpub dashboard only - which derived address this transaction touched.
  // Absent on the single-address dashboard (redundant there - it's always
  // the address you queried).
  address?: string;
};

export type BlockchairAddressDashboard = {
  address: BlockchairAddressStats;
  transactions: BlockchairTransactionSummary[];
};

export async function getBitcoinAddressDashboard(
  address: string,
): Promise<BlockchairAddressDashboard> {
  if (!address || address.trim().length === 0) {
    throw new Error("Bitcoin address is required");
  }

  const trimmedAddress = address.trim();

  const data = await callBlockchairRest<
    Record<string, BlockchairAddressDashboard>
  >(`/dashboards/address/${trimmedAddress}`, {
    limit: "100",
    transaction_details: "true",
  });

  const entry = data[trimmedAddress];

  if (!entry) {
    throw new Error(
      `Blockchair returned no dashboard data for address "${trimmedAddress}"`,
    );
  }

  return {
    address: entry.address ?? {},
    transactions: Array.isArray(entry.transactions) ? entry.transactions : [],
  };
}

export type BlockchairXpubStats = {
  address_count?: number;
  balance?: number;
  balance_usd?: number;
  received?: number;
  spent?: number;
  output_count?: number;
  unspent_output_count?: number;
  first_seen_receiving?: string | null;
  last_seen_receiving?: string | null;
  first_seen_spending?: string | null;
  last_seen_spending?: string | null;
  transaction_count?: number;
};

export type BlockchairXpubDerivedAddress = BlockchairAddressStats & {
  path?: string;
};

export type BlockchairXpubDashboard = {
  xpub: BlockchairXpubStats;
  addresses: Record<string, BlockchairXpubDerivedAddress>;
  transactions: BlockchairTransactionSummary[];
};

export async function getBitcoinXpubDashboard(
  xpub: string,
): Promise<BlockchairXpubDashboard> {
  if (!xpub || xpub.trim().length === 0) {
    throw new Error("Bitcoin extended public key is required");
  }

  const trimmedXpub = xpub.trim();

  const data = await callBlockchairRest<
    Record<string, BlockchairXpubDashboard>
  >(`/dashboards/xpub/${trimmedXpub}`, {
    limit: "100,0",
    transaction_details: "true",
  });

  const entry = data[trimmedXpub];

  if (!entry) {
    throw new Error(
      `Blockchair returned no dashboard data for the provided extended public key`,
    );
  }

  return {
    xpub: entry.xpub ?? {},
    addresses: entry.addresses ?? {},
    transactions: Array.isArray(entry.transactions) ? entry.transactions : [],
  };
}

type BlockchairTransactionDashboardEntry = {
  transaction?: {
    block_id?: number;
    hash?: string;
    time?: string;
  };
};

// Blockchair's single-transaction endpoint also returns full inputs[]/
// outputs[] (live-confirmed - recipient addresses, values, spent status),
// but only block_id/hash/time are surfaced here. Decoding inputs/outputs
// into real transfers is transaction PARSING, which chains/bitcoin.ts's
// capabilities deliberately mark false for this MVP, same "listed, not
// parsed" honest-partial state Ethereum's connector shipped with initially
// (see chains/ethereum.ts's descriptor limitations).
export async function getBitcoinTransaction(
  transactionHash: string,
): Promise<BlockchairTransactionSummary | null> {
  if (!transactionHash || transactionHash.trim().length === 0) {
    throw new Error("Bitcoin transaction hash is required");
  }

  const trimmedHash = transactionHash.trim();

  const data = await callBlockchairRest<
    Record<string, BlockchairTransactionDashboardEntry>
  >(`/dashboards/transaction/${trimmedHash}`);

  const entry = data[trimmedHash];
  const transaction = entry?.transaction;

  if (!transaction || !transaction.hash) {
    return null;
  }

  return {
    hash: transaction.hash,
    block_id: transaction.block_id,
    time: transaction.time,
  };
}

// Format detection only - no network call. Distinguishes "this string is a
// single Bitcoin address" from "this string is an extended public key" so a
// caller (the future Bitcoin connector) can route to the right dashboard
// endpoint. Deliberately permissive on length (real-world xpubs are ~111
// chars, but this only needs to be right about the prefix to pick an
// endpoint - Blockchair itself is the source of truth for whether the full
// string is actually valid).
const BITCOIN_XPUB_PREFIXES = ["xpub", "ypub", "zpub"];
const BITCOIN_ADDRESS_PREFIXES = ["1", "3", "bc1"];

export function isBitcoinXpub(input: string): boolean {
  const trimmed = input.trim();

  return BITCOIN_XPUB_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

export function isBitcoinAddress(input: string): boolean {
  const trimmed = input.trim();

  return (
    !isBitcoinXpub(trimmed) &&
    BITCOIN_ADDRESS_PREFIXES.some((prefix) => trimmed.startsWith(prefix))
  );
}
