/**
 * Monero chain module.
 *
 * Custody split (mirrors the repo's no-hand-rolled-signature-crypto policy):
 *   - Key generation and address derivation happen IN-PROCESS from vetted
 *     primitives (@noble/curves ed25519 + @noble/hashes keccak), the same
 *     precedent as hd-wallet.ts's self-contained SLIP-10/bech32m code. Keys
 *     are born in vault memory and encrypted under the standard keystore AAD
 *     context before any use.
 *   - Transaction crypto (CryptoNote key derivation, CLSAG ring signatures,
 *     RingCT) is NEVER hand-rolled. It is delegated to the official
 *     monero-wallet-rpc (wallet2) running as a private sidecar, which itself
 *     talks to an explicitly configured daemon
 *     with --untrusted-daemon. Private keys reach the sidecar only transiently
 *     (generate_from_keys) over the internal network; the remote daemon never
 *     sees key material — it only serves block data and receives fully-signed
 *     transactions.
 *   - The encrypted key payload in the DB is CANONICAL. wallet-rpc wallet
 *     files are a disposable scan cache, rehydrated from the payload at any
 *     time; restoreHeight is captured at creation so rehydration scans almost
 *     nothing ("light" client: no monerod, no blockchain storage, incremental
 *     wallet scan only).
 *
 * Fail-closed posture: every entry point throws MoneroNotConfiguredError when
 * the wallet-rpc backend is not configured (e.g. the Cloudflare Workers
 * deployment). There is no mock fallback.
 */

import { createHash, createHmac, randomBytes } from "node:crypto";
import { bytesToNumberLE, numberToBytesLE } from "@noble/curves/abstract/utils";
import { ed25519 } from "@noble/curves/ed25519";
import { keccak_256 } from "@noble/hashes/sha3";

import type {
  MoneroNetwork,
  MoneroWalletMetadata,
} from "../../shared/src/index.ts";

// ─── Constants ────────────────────────────────────────────────────────────────

/** 1 XMR = 10^12 piconero. */
export const MONERO_ATOMIC_UNITS = 10n ** 12n;

/** wallet2 stores amounts as uint64; anything larger is malformed. */
const MAX_UINT64 = 2n ** 64n - 1n;

/** ed25519 group order l (scalars live in Z_l). */
const CURVE_ORDER = ed25519.CURVE.n;

/**
 * Monero address network-prefix bytes (all single-byte varints).
 * kind: standard = primary address, integrated = standard + 8-byte payment id,
 * subaddress = per-receiver address derived from the primary keys.
 */
const ADDRESS_PREFIXES: Record<
  MoneroNetwork,
  { standard: number; integrated: number; subaddress: number }
> = {
  mainnet: { standard: 18, integrated: 19, subaddress: 42 },
  stagenet: { standard: 24, integrated: 25, subaddress: 36 },
};

// ─── Errors ───────────────────────────────────────────────────────────────────

/** Thrown when Monero support is not configured. Routes map this to a 503. */
export class MoneroNotConfiguredError extends Error {
  constructor(detail?: string) {
    super(
      `Monero wallet backend is not configured.${detail ? ` ${detail}` : ""} ` +
        "Set STEWARD_MONERO_WALLET_RPC_URL (and run the monero-wallet-rpc sidecar) to enable Monero support.",
    );
    this.name = "MoneroNotConfiguredError";
  }
}

/**
 * A JSON-RPC-level failure from monero-wallet-rpc or the daemon. Carries the
 * method and RPC error only — request params (which may contain key material)
 * are never included.
 */
export class MoneroRpcError extends Error {
  readonly method: string;
  readonly code: number | undefined;
  constructor(method: string, message: string, code?: number) {
    super(`monero ${method} failed: ${message}`);
    this.name = "MoneroRpcError";
    this.method = method;
    this.code = code;
  }
}

// ─── Hex helpers ──────────────────────────────────────────────────────────────

/** Monero key material is UNPREFIXED 64-char hex (wallet-rpc convention). */
export function isMoneroKeyHex(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function decodeHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function encodeHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

// ─── Monero base58 ────────────────────────────────────────────────────────────
//
// Monero uses block-wise base58 (not Bitcoin's stream base58): the payload is
// split into 8-byte blocks, each encoded big-endian into exactly 11 chars
// (left-padded with '1'); a final partial block of n bytes encodes into
// ENCODED_BLOCK_SIZES[n] chars. Self-contained by design, like the bech32
// implementation in hd-wallet.ts.

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ENCODED_BLOCK_SIZES = [0, 2, 3, 5, 6, 7, 9, 10, 11] as const;
const FULL_BLOCK_SIZE = 8;
const FULL_ENCODED_BLOCK_SIZE = 11;

function encodeBase58Block(block: Uint8Array): string {
  let num = 0n;
  for (const byte of block) num = num * 256n + BigInt(byte);
  const size = ENCODED_BLOCK_SIZES[block.length];
  let out = "";
  while (num > 0n) {
    out = BASE58_ALPHABET[Number(num % 58n)] + out;
    num /= 58n;
  }
  return out.padStart(size, "1");
}

function decodeBase58Block(block: string, byteLength: number): Uint8Array {
  let num = 0n;
  for (const char of block) {
    const digit = BASE58_ALPHABET.indexOf(char);
    if (digit < 0)
      throw new Error("Monero address contains an invalid base58 character");
    num = num * 58n + BigInt(digit);
  }
  const out = new Uint8Array(byteLength);
  for (let i = byteLength - 1; i >= 0; i--) {
    out[i] = Number(num % 256n);
    num /= 256n;
  }
  if (num > 0n)
    throw new Error("Monero address base58 block overflows its byte length");
  return out;
}

export function encodeMoneroBase58(data: Uint8Array): string {
  let out = "";
  for (let i = 0; i < data.length; i += FULL_BLOCK_SIZE) {
    out += encodeBase58Block(
      data.subarray(i, Math.min(i + FULL_BLOCK_SIZE, data.length)),
    );
  }
  return out;
}

export function decodeMoneroBase58(encoded: string): Uint8Array {
  const fullBlocks = Math.floor(encoded.length / FULL_ENCODED_BLOCK_SIZE);
  const lastBlockChars = encoded.length % FULL_ENCODED_BLOCK_SIZE;
  const lastBlockBytes = ENCODED_BLOCK_SIZES.indexOf(
    lastBlockChars as (typeof ENCODED_BLOCK_SIZES)[number],
  );
  if (lastBlockBytes < 0)
    throw new Error("Monero address has an invalid base58 length");
  const out = new Uint8Array(fullBlocks * FULL_BLOCK_SIZE + lastBlockBytes);
  for (let i = 0; i < fullBlocks; i++) {
    out.set(
      decodeBase58Block(
        encoded.slice(
          i * FULL_ENCODED_BLOCK_SIZE,
          (i + 1) * FULL_ENCODED_BLOCK_SIZE,
        ),
        FULL_BLOCK_SIZE,
      ),
      i * FULL_BLOCK_SIZE,
    );
  }
  if (lastBlockBytes > 0) {
    out.set(
      decodeBase58Block(
        encoded.slice(fullBlocks * FULL_ENCODED_BLOCK_SIZE),
        lastBlockBytes,
      ),
      fullBlocks * FULL_BLOCK_SIZE,
    );
  }
  return out;
}

// ─── Key + address derivation ─────────────────────────────────────────────────

function scalarFromBytesModOrder(bytes: Uint8Array): bigint {
  // Matches Monero's sc_reduce32: interpret 32 LE bytes, reduce mod l.
  return bytesToNumberLE(bytes) % CURVE_ORDER;
}

function publicKeyFromScalar(scalar: bigint): Uint8Array {
  return ed25519.ExtendedPoint.BASE.multiply(scalar).toRawBytes();
}

function moneroChecksum(payload: Uint8Array): Uint8Array {
  return keccak_256(payload).subarray(0, 4);
}

/**
 * Monero public keys must be non-identity points in ed25519's prime-order
 * subgroup. Merely accepting a canonical compressed encoding also accepts the
 * identity, low-order torsion points, and points with a torsion component.
 */
function assertValidMoneroPublicKey(encoded: Uint8Array): void {
  let point: typeof ed25519.ExtendedPoint.BASE;
  try {
    point = ed25519.ExtendedPoint.fromHex(encoded);
  } catch {
    throw new Error("Monero address embeds an invalid ed25519 public key");
  }
  if (point.is0() || point.isSmallOrder() || !point.isTorsionFree()) {
    throw new Error(
      "Monero public key is not in the prime-order ed25519 subgroup",
    );
  }
}

export interface GeneratedMoneroWallet {
  /** Private spend key, 64-hex (SECRET). */
  spendKey: string;
  /** Private view key, 64-hex (SECRET in Monero's privacy model). */
  viewKey: string;
  publicSpendKey: string;
  publicViewKey: string;
  /** Primary (standard) address for account 0. */
  address: string;
  network: MoneroNetwork;
}

/**
 * Build the standard address for a public key pair:
 *   base58( prefix || pubSpend(32) || pubView(32) || keccak256(...)[0..4) )
 */
export function moneroAddressFromPublicKeys(
  publicSpendKey: string,
  publicViewKey: string,
  network: MoneroNetwork,
): string {
  if (!isMoneroKeyHex(publicSpendKey) || !isMoneroKeyHex(publicViewKey)) {
    throw new Error("Monero public keys must be 32-byte lowercase hex strings");
  }
  assertValidMoneroPublicKey(decodeHex(publicSpendKey));
  assertValidMoneroPublicKey(decodeHex(publicViewKey));
  const payload = new Uint8Array(69);
  payload[0] = ADDRESS_PREFIXES[network].standard;
  payload.set(decodeHex(publicSpendKey), 1);
  payload.set(decodeHex(publicViewKey), 33);
  payload.set(moneroChecksum(payload.subarray(0, 65)), 65);
  return encodeMoneroBase58(payload);
}

/**
 * Generate a fresh Monero key pair in-process.
 *
 * Standard Monero derivation: random spend scalar (sc_reduce32 of 32 random
 * bytes), view scalar = keccak256(spendKey) reduced mod l — so exporting the
 * spend key alone is sufficient to restore the wallet anywhere.
 */
export function generateMoneroWallet(
  network: MoneroNetwork,
): GeneratedMoneroWallet {
  let spendScalar = 0n;
  // Rejection loop: scalar 0 is invalid (probability ~2^-252, but fail closed).
  while (spendScalar === 0n) {
    spendScalar = scalarFromBytesModOrder(new Uint8Array(randomBytes(32)));
  }
  const spendKeyBytes = numberToBytesLE(spendScalar, 32);
  const viewScalar = scalarFromBytesModOrder(keccak_256(spendKeyBytes));
  if (viewScalar === 0n) {
    // Unreachable in practice; regenerating keeps the invariant explicit.
    return generateMoneroWallet(network);
  }
  const publicSpendKey = encodeHex(publicKeyFromScalar(spendScalar));
  const publicViewKey = encodeHex(publicKeyFromScalar(viewScalar));
  return {
    spendKey: encodeHex(spendKeyBytes),
    viewKey: encodeHex(numberToBytesLE(viewScalar, 32)),
    publicSpendKey,
    publicViewKey,
    address: moneroAddressFromPublicKeys(
      publicSpendKey,
      publicViewKey,
      network,
    ),
    network,
  };
}

// ─── Address validation ───────────────────────────────────────────────────────

export type MoneroAddressKind = "standard" | "integrated" | "subaddress";

export interface DecodedMoneroAddress {
  network: MoneroNetwork;
  kind: MoneroAddressKind;
  publicSpendKey: string;
  publicViewKey: string;
  /** 8-byte payment id (hex), integrated addresses only. */
  paymentId?: string;
}

/**
 * Decode + fully validate a Monero address: base58 shape, checksum, network
 * prefix, payload length for its kind, and that both embedded public keys are
 * canonical ed25519 points. Base58 is case-significant — no normalization.
 */
export function decodeMoneroAddress(address: string): DecodedMoneroAddress {
  if (
    typeof address !== "string" ||
    (address.length !== 95 && address.length !== 106)
  ) {
    throw new Error(
      "Monero address must be a 95-char (standard/subaddress) or 106-char (integrated) base58 string",
    );
  }
  const payload = decodeMoneroBase58(address);
  if (payload.length !== 69 && payload.length !== 77) {
    throw new Error("Monero address payload has an invalid length");
  }
  const body = payload.subarray(0, payload.length - 4);
  const checksum = payload.subarray(payload.length - 4);
  const expected = moneroChecksum(body);
  if (!checksum.every((byte, i) => byte === expected[i])) {
    throw new Error("Monero address checksum mismatch");
  }
  const prefix = payload[0];
  let network: MoneroNetwork | undefined;
  let kind: MoneroAddressKind | undefined;
  for (const [net, prefixes] of Object.entries(ADDRESS_PREFIXES) as Array<
    [MoneroNetwork, (typeof ADDRESS_PREFIXES)[MoneroNetwork]]
  >) {
    for (const [addressKind, byte] of Object.entries(prefixes) as Array<
      [MoneroAddressKind, number]
    >) {
      if (byte === prefix) {
        network = net;
        kind = addressKind;
      }
    }
  }
  if (!network || !kind) {
    throw new Error("Monero address has an unknown network prefix");
  }
  const expectedLength = kind === "integrated" ? 77 : 69;
  if (payload.length !== expectedLength) {
    throw new Error(`Monero ${kind} address has an invalid payload length`);
  }
  const publicSpendKeyBytes = payload.subarray(1, 33);
  const publicViewKeyBytes = payload.subarray(33, 65);
  for (const key of [publicSpendKeyBytes, publicViewKeyBytes]) {
    assertValidMoneroPublicKey(key);
  }
  const publicSpendKey = encodeHex(publicSpendKeyBytes);
  const publicViewKey = encodeHex(publicViewKeyBytes);
  return {
    network,
    kind,
    publicSpendKey,
    publicViewKey,
    ...(kind === "integrated"
      ? { paymentId: encodeHex(payload.subarray(65, 73)) }
      : {}),
  };
}

/** Validate that `address` is a valid Monero destination on `network`. */
export function assertMoneroAddress(
  address: string,
  network: MoneroNetwork,
): DecodedMoneroAddress {
  const decoded = decodeMoneroAddress(address);
  if (decoded.network !== network) {
    throw new Error(
      `Monero address is for ${decoded.network} but this wallet operates on ${network}`,
    );
  }
  return decoded;
}

// ─── Amounts ──────────────────────────────────────────────────────────────────

/** Parse a positive piconero amount expressed as a decimal string. */
export function parsePiconeroAmount(value: unknown): bigint {
  if (typeof value !== "string" || !/^[0-9]{1,20}$/.test(value)) {
    throw new Error("Monero amount must be a decimal piconero string");
  }
  const amount = BigInt(value);
  if (amount <= 0n) throw new Error("Monero amount must be greater than zero");
  if (amount > MAX_UINT64)
    throw new Error("Monero amount exceeds uint64 range");
  return amount;
}

// ─── Wallet scope + key payload ───────────────────────────────────────────────

/**
 * Wallet scope stored in the `venue` column (Bitcoin precedent):
 *   monero:<network>:<account>
 */
export function moneroWalletScope(
  network: MoneroNetwork,
  account: number,
): string {
  if (network !== "mainnet" && network !== "stagenet") {
    throw new Error("Unsupported Monero network");
  }
  if (!Number.isInteger(account) || account < 0 || account > 2 ** 31 - 1) {
    throw new Error("Monero account index must be a non-negative integer");
  }
  return `monero:${network}:${account}`;
}

export interface ParsedMoneroWalletScope {
  network: MoneroNetwork;
  account: number;
}

export function parseMoneroWalletScope(scope: string): ParsedMoneroWalletScope {
  const match = /^monero:(mainnet|stagenet):(0|[1-9][0-9]{0,9})$/.exec(scope);
  if (!match) {
    throw new Error(
      "Monero wallet scope must look like monero:<network>:<account>",
    );
  }
  const account = Number(match[2]);
  if (account > 2 ** 31 - 1) {
    throw new Error("Monero account index must be a non-negative integer");
  }
  return { network: match[1] as MoneroNetwork, account };
}

/**
 * The single string encrypted into `encrypted_chain_keys`. Versioned so the
 * payload can evolve without re-encrypting existing rows blindly.
 */
export interface MoneroKeyPayloadV1 {
  v: 1;
  network: MoneroNetwork;
  /** Private spend key, 64-hex (SECRET). */
  spendKey: string;
  /** Private view key, 64-hex (SECRET in Monero's privacy model). */
  viewKey: string;
  /** Primary address; cross-checked against wallet2's own derivation. */
  address: string;
  /** Chain height at creation; wallet scanning starts here. */
  restoreHeight: number;
  account: number;
}

export function serializeMoneroKeyPayload(payload: MoneroKeyPayloadV1): string {
  // Validate before persisting — a malformed payload is unrecoverable custody.
  assertMoneroKeyPayload(payload);
  return JSON.stringify(payload);
}

export function parseMoneroKeyPayload(serialized: string): MoneroKeyPayloadV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error("Monero key payload is not valid JSON");
  }
  assertMoneroKeyPayload(parsed);
  return parsed;
}

function assertMoneroKeyPayload(
  value: unknown,
): asserts value is MoneroKeyPayloadV1 {
  if (typeof value !== "object" || value === null) {
    throw new Error("Monero key payload must be an object");
  }
  const payload = value as Record<string, unknown>;
  if (payload.v !== 1)
    throw new Error("Unsupported Monero key payload version");
  if (payload.network !== "mainnet" && payload.network !== "stagenet") {
    throw new Error("Monero key payload has an unsupported network");
  }
  if (!isMoneroKeyHex(payload.spendKey)) {
    throw new Error("Monero key payload spendKey is malformed");
  }
  if (!isMoneroKeyHex(payload.viewKey)) {
    throw new Error("Monero key payload viewKey is malformed");
  }
  if (
    typeof payload.restoreHeight !== "number" ||
    !Number.isInteger(payload.restoreHeight) ||
    payload.restoreHeight < 0
  ) {
    throw new Error("Monero key payload restoreHeight is malformed");
  }
  if (
    typeof payload.account !== "number" ||
    !Number.isInteger(payload.account) ||
    payload.account < 0
  ) {
    throw new Error("Monero key payload account is malformed");
  }
  const decoded = decodeMoneroAddress(payload.address as string);
  if (decoded.network !== payload.network || decoded.kind !== "standard") {
    throw new Error("Monero key payload address does not match its network");
  }
}

export function moneroPublicMetadataFromPayload(
  payload: MoneroKeyPayloadV1,
  caip2: string,
): MoneroWalletMetadata {
  const decoded = decodeMoneroAddress(payload.address);
  return {
    network: payload.network,
    address: payload.address,
    publicSpendKey: decoded.publicSpendKey,
    publicViewKey: decoded.publicViewKey,
    restoreHeight: payload.restoreHeight,
    account: payload.account,
    caip2,
  };
}

// ─── Wallet backend seam ──────────────────────────────────────────────────────

export interface MoneroBalanceResult {
  balancePiconero: bigint;
  unlockedPiconero: bigint;
  blocksToUnlock: number;
  syncedHeight: number;
}

export interface MoneroTransferDestination {
  address: string;
  amountPiconero: bigint;
}

export interface PreparedMoneroTransfer {
  /** Signed-but-unrelayed transaction blob; broadcastable, keep in memory only. */
  txMetadata: string;
  txHash: string;
  feePiconero: bigint;
  amountPiconero: bigint;
}

export interface MoneroWalletBackendContext {
  /** Filesystem-safe stable cache id for the wallet file (non-reversible). */
  cacheId: string;
}

/**
 * The seam between the vault and whatever performs Monero wallet operations.
 * The default implementation drives a monero-wallet-rpc sidecar; an in-process
 * WASM wallet could replace it without touching vault methods or routes.
 *
 * Implementations NEVER relay in prepareTransfer — the two-phase
 * prepare/relay split exists so the fee-inclusive aggregate policy check runs
 * between signing and broadcast.
 */
export interface MoneroWalletBackend {
  readonly network: MoneroNetwork;
  /** Current daemon chain height (used as restoreHeight for new wallets). */
  getDaemonHeight(): Promise<number>;
  /**
   * Load the wallet into wallet2 and cross-check that wallet2 independently
   * derives the same primary address (dual-derivation validation). Throws on
   * any mismatch.
   */
  verifyWalletKeys(
    payload: MoneroKeyPayloadV1,
    context: MoneroWalletBackendContext,
  ): Promise<void>;
  getBalance(
    payload: MoneroKeyPayloadV1,
    context: MoneroWalletBackendContext,
  ): Promise<MoneroBalanceResult>;
  prepareTransfer(
    payload: MoneroKeyPayloadV1,
    context: MoneroWalletBackendContext,
    request: { destinations: MoneroTransferDestination[]; priority?: number },
  ): Promise<PreparedMoneroTransfer>;
  /**
   * Relay a previously prepared transaction. Takes the wallet identity
   * because wallet-rpc's relay_tx requires the signing wallet to be open
   * (it fails with -13 "No wallet file" otherwise).
   */
  relayTransfer(
    payload: MoneroKeyPayloadV1,
    context: MoneroWalletBackendContext,
    txMetadata: string,
  ): Promise<{ txHash: string }>;
  /** Best-effort cache repair after a prepared transfer is discarded. */
  discardPreparedTransfer(
    payload: MoneroKeyPayloadV1,
    context: MoneroWalletBackendContext,
  ): Promise<void>;
}

// ─── JSON-RPC plumbing (uint64-safe) ─────────────────────────────────────────
//
// Piconero amounts can exceed Number.MAX_SAFE_INTEGER (2^53 piconero ≈ 9007
// XMR), so request bodies serialize bigints as bare JSON integers and response
// bodies quote long integers before JSON.parse. Anything less silently rounds
// balances/fees in a money path.

function stringifyWithBigints(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (typeof val === "bigint") return `__BIGINT__${val.toString()}__`;
    return val;
  }).replace(/"__BIGINT__(\d+)__"/g, "$1");
}

function parseWithBigIntegers(text: string): unknown {
  // Quote integers of 15+ digits so JSON.parse keeps them exact as strings.
  // The trailing delimiter is a lookahead (not consumed) so ADJACENT large
  // numbers ("[111…1,222…2]") both match — a consuming group here silently
  // rounds every other array element through Number.
  const quoted = text.replace(/([:[,]\s*)(\d{15,})(?=\s*[,}\]])/g, '$1"$2"');
  return JSON.parse(quoted);
}

function toBigIntField(value: unknown, field: string): bigint {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  if (typeof value === "string" && /^[0-9]+$/.test(value)) return BigInt(value);
  throw new Error(
    `monero RPC response field ${field} is not a non-negative integer`,
  );
}

function toNumberField(value: unknown, field: string): number {
  const asBigint = toBigIntField(value, field);
  if (asBigint > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(
      `monero RPC response field ${field} exceeds safe integer range`,
    );
  }
  return Number(asBigint);
}

// ─── HTTP digest auth (monero-wallet-rpc --rpc-login) ────────────────────────

interface DigestChallenge {
  realm: string;
  nonce: string;
  qop?: string;
  algorithm?: string;
}

function parseDigestChallenge(header: string): DigestChallenge {
  const params: Record<string, string> = {};
  const re = /(\w+)=(?:"([^"]*)"|([^,\s]+))/g;
  let match = re.exec(header);
  while (match) {
    params[match[1].toLowerCase()] = match[2] ?? match[3];
    match = re.exec(header);
  }
  if (!params.realm || !params.nonce) {
    throw new Error("monero wallet-rpc digest challenge is malformed");
  }
  return {
    realm: params.realm,
    nonce: params.nonce,
    qop: params.qop,
    algorithm: params.algorithm,
  };
}

function md5Hex(value: string): string {
  // MD5 is what RFC 7616 digest auth with algorithm=MD5 requires; it
  // authenticates a private-network RPC session and protects no stored data.
  return createHash("md5").update(value).digest("hex");
}

function buildDigestAuthorization(
  challenge: DigestChallenge,
  username: string,
  password: string,
  method: string,
  uri: string,
): string {
  const ha1 = md5Hex(`${username}:${challenge.realm}:${password}`);
  const ha2 = md5Hex(`${method}:${uri}`);
  const nc = "00000001";
  const cnonce = encodeHex(new Uint8Array(randomBytes(16)));
  const qop = challenge.qop
    ?.split(",")
    .map((q) => q.trim())
    .includes("auth")
    ? "auth"
    : undefined;
  const response = qop
    ? md5Hex(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : md5Hex(`${ha1}:${challenge.nonce}:${ha2}`);
  const parts = [
    `username="${username}"`,
    `realm="${challenge.realm}"`,
    `nonce="${challenge.nonce}"`,
    `uri="${uri}"`,
    `response="${response}"`,
    `algorithm=MD5`,
  ];
  if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  return `Digest ${parts.join(", ")}`;
}

// ─── monero-wallet-rpc backend ────────────────────────────────────────────────

/**
 * Async mutex: wallet-rpc holds at most one wallet open at a time.
 *
 * This serializes wallet sessions WITHIN one process only. A wallet-rpc
 * sidecar must be paired with a single vault process — when scaling API
 * replicas, give each replica its own sidecar (wallet files rehydrate from
 * the DB, so sidecars are stateless-by-design and cheap to multiply).
 */
class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release: () => void = () => {};
    this.tail = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  }
}

export interface MoneroWalletRpcBackendConfig {
  network: MoneroNetwork;
  /** monero-wallet-rpc JSON-RPC endpoint, e.g. http://monero-wallet-rpc:18083/json_rpc */
  rpcUrl: string;
  /** "user:password" for --rpc-login; omit only when the sidecar runs with --disable-rpc-login. */
  rpcLogin?: string;
  /** Restricted daemon used ONLY for chain height at wallet creation. */
  daemonUrl: string;
  /** Per-RPC-call timeout; wallet refresh/transfer can legitimately take a while. */
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

const DEFAULT_RPC_TIMEOUT_MS = 120_000;

function isPrivateHttpHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1" || host.endsWith(".localhost"))
    return true;
  if (!host.includes(".")) return true; // Docker/Kubernetes service name.
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host))
    return true;
  const match = /^172\.(\d+)\./.exec(host);
  return !!match && Number(match[1]) >= 16 && Number(match[1]) <= 31;
}

function validateRpcTransport(rawUrl: string, field: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`${field} must be a valid HTTP(S) URL`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${field} must not embed credentials in the URL`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`${field} must use HTTP(S)`);
  }
  if (parsed.protocol === "http:" && !isPrivateHttpHost(parsed.hostname)) {
    throw new Error(`${field} must use HTTPS for a non-private host`);
  }
  return parsed.toString().replace(/\/$/, "");
}

export class MoneroWalletRpcBackend implements MoneroWalletBackend {
  readonly network: MoneroNetwork;
  private readonly rpcUrl: string;
  private readonly daemonUrl: string;
  private readonly login: { username: string; password: string } | undefined;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly mutex = new AsyncMutex();

  constructor(config: MoneroWalletRpcBackendConfig) {
    if (!config.rpcUrl) throw new MoneroNotConfiguredError();
    this.network = config.network;
    this.rpcUrl = validateRpcTransport(
      config.rpcUrl,
      "STEWARD_MONERO_WALLET_RPC_URL",
    );
    this.daemonUrl = validateRpcTransport(
      config.daemonUrl,
      "STEWARD_MONERO_DAEMON_URL",
    );
    this.timeoutMs = config.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
    this.fetchFn = config.fetchFn ?? fetch;
    if (config.rpcLogin) {
      const separator = config.rpcLogin.indexOf(":");
      if (separator <= 0 || separator === config.rpcLogin.length - 1) {
        throw new Error(
          "STEWARD_MONERO_WALLET_RPC_LOGIN must look like user:password",
        );
      }
      this.login = {
        username: config.rpcLogin.slice(0, separator),
        password: config.rpcLogin.slice(separator + 1),
      };
    }
  }

  async getDaemonHeight(): Promise<number> {
    const url = `${this.daemonUrl}/get_height`;
    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new MoneroRpcError("get_height", errorMessage(error));
    }
    if (!response.ok) {
      throw new MoneroRpcError(
        "get_height",
        `daemon returned HTTP ${response.status}`,
      );
    }
    const body = parseWithBigIntegers(await response.text()) as Record<
      string,
      unknown
    >;
    if (body.status !== "OK") {
      throw new MoneroRpcError(
        "get_height",
        `daemon status ${String(body.status)}`,
      );
    }
    return toNumberField(body.height, "height");
  }

  async verifyWalletKeys(
    payload: MoneroKeyPayloadV1,
    context: MoneroWalletBackendContext,
  ): Promise<void> {
    await this.mutex.run(async () => {
      try {
        await this.ensureWalletLoaded(payload, context);
      } finally {
        await this.closeWalletQuietly();
      }
    });
  }

  async getBalance(
    payload: MoneroKeyPayloadV1,
    context: MoneroWalletBackendContext,
  ): Promise<MoneroBalanceResult> {
    return this.mutex.run(async () => {
      try {
        await this.ensureWalletLoaded(payload, context);
        await this.walletRpc("refresh", {});
        const balance = (await this.walletRpc("get_balance", {
          account_index: payload.account,
        })) as Record<string, unknown>;
        const height = (await this.walletRpc("get_height", {})) as Record<
          string,
          unknown
        >;
        return {
          balancePiconero: toBigIntField(balance.balance, "balance"),
          unlockedPiconero: toBigIntField(
            balance.unlocked_balance,
            "unlocked_balance",
          ),
          blocksToUnlock: toNumberField(
            balance.blocks_to_unlock ?? 0,
            "blocks_to_unlock",
          ),
          syncedHeight: toNumberField(height.height, "height"),
        };
      } finally {
        await this.closeWalletQuietly();
      }
    });
  }

  async prepareTransfer(
    payload: MoneroKeyPayloadV1,
    context: MoneroWalletBackendContext,
    request: { destinations: MoneroTransferDestination[]; priority?: number },
  ): Promise<PreparedMoneroTransfer> {
    if (request.destinations.length === 0) {
      throw new Error("Monero transfer requires at least one destination");
    }
    for (const destination of request.destinations) {
      assertMoneroAddress(destination.address, payload.network);
      if (
        destination.amountPiconero <= 0n ||
        destination.amountPiconero > MAX_UINT64
      ) {
        throw new Error("Monero transfer amount is out of range");
      }
    }
    if (
      request.priority !== undefined &&
      (!Number.isInteger(request.priority) ||
        request.priority < 0 ||
        request.priority > 3)
    ) {
      throw new Error(
        "Monero transfer priority must be an integer between 0 and 3",
      );
    }
    return this.mutex.run(async () => {
      try {
        await this.ensureWalletLoaded(payload, context);
        await this.walletRpc("refresh", {});
        const result = (await this.walletRpc("transfer", {
          destinations: request.destinations.map((destination) => ({
            address: destination.address,
            amount: destination.amountPiconero,
          })),
          account_index: payload.account,
          priority: request.priority ?? 0,
          do_not_relay: true,
          get_tx_metadata: true,
        })) as Record<string, unknown>;
        const txMetadata = result.tx_metadata;
        const txHash = result.tx_hash;
        if (typeof txMetadata !== "string" || txMetadata.length === 0) {
          throw new MoneroRpcError(
            "transfer",
            "response is missing tx_metadata",
          );
        }
        if (typeof txHash !== "string" || !/^[0-9a-f]{64}$/.test(txHash)) {
          throw new MoneroRpcError("transfer", "response tx_hash is malformed");
        }
        return {
          txMetadata,
          txHash,
          feePiconero: toBigIntField(result.fee, "fee"),
          amountPiconero: toBigIntField(result.amount, "amount"),
        };
      } finally {
        await this.closeWalletQuietly();
      }
    });
  }

  async relayTransfer(
    payload: MoneroKeyPayloadV1,
    context: MoneroWalletBackendContext,
    txMetadata: string,
  ): Promise<{ txHash: string }> {
    if (typeof txMetadata !== "string" || txMetadata.length === 0) {
      throw new Error(
        "Monero relay requires the prepared transaction metadata",
      );
    }
    return this.mutex.run(async () => {
      try {
        // relay_tx needs the signing wallet open (verified against
        // monero-wallet-rpc v0.18.5.0: -13 "No wallet file" otherwise).
        await this.ensureWalletLoaded(payload, context);
        const result = (await this.walletRpc("relay_tx", {
          hex: txMetadata,
        })) as Record<string, unknown>;
        const txHash = result.tx_hash;
        if (typeof txHash !== "string" || !/^[0-9a-f]{64}$/.test(txHash)) {
          throw new MoneroRpcError("relay_tx", "response tx_hash is malformed");
        }
        return { txHash };
      } finally {
        await this.closeWalletQuietly();
      }
    });
  }

  async discardPreparedTransfer(
    payload: MoneroKeyPayloadV1,
    context: MoneroWalletBackendContext,
  ): Promise<void> {
    // Building a tx can mark outputs as pending-spent in the wallet cache.
    // rescan_spent re-derives spent status from the daemon so a policy-denied
    // (never relayed) transfer does not strand outputs until rehydration.
    try {
      await this.mutex.run(async () => {
        try {
          await this.ensureWalletLoaded(payload, context);
          await this.walletRpc("rescan_spent", {});
        } finally {
          await this.closeWalletQuietly();
        }
      });
    } catch {
      // Best-effort: the cache is disposable and self-heals on rehydration.
    }
  }

  /**
   * Open the wallet cache, rehydrating it from canonical key material when the
   * file does not exist yet, then cross-check wallet2's derived address.
   * MUST be called while holding the mutex.
   */
  private async ensureWalletLoaded(
    payload: MoneroKeyPayloadV1,
    context: MoneroWalletBackendContext,
  ): Promise<void> {
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(context.cacheId)) {
      throw new Error("Monero wallet cache id is malformed");
    }
    const filename = `stw-${context.cacheId}`;
    const password = walletCachePassword(payload.spendKey);
    try {
      await this.walletRpc("open_wallet", { filename, password });
    } catch (openError) {
      // wallet-rpc's open_wallet error is generic ("Failed to open wallet")
      // for both missing and unreadable files, so rehydrate on any open
      // failure and let generate_from_keys disambiguate.
      if (
        !(openError instanceof MoneroRpcError) ||
        openError.method !== "open_wallet"
      ) {
        throw openError;
      }
      try {
        const generated = (await this.walletRpc("generate_from_keys", {
          filename,
          password,
          address: payload.address,
          spendkey: payload.spendKey,
          viewkey: payload.viewKey,
          restore_height: payload.restoreHeight,
          autosave_current: true,
        })) as Record<string, unknown>;
        if (generated.address !== payload.address) {
          await this.closeWalletQuietly();
          throw new Error(
            "monero-wallet-rpc derived a different address for this wallet's keys — refusing to proceed",
          );
        }
      } catch (generateError) {
        if (!isWalletExistsError(generateError)) throw generateError;
        // The file exists but open_wallet failed. Either another process
        // just rehydrated it (retry the open) or the cache file is
        // corrupted/foreign (fail with operator guidance — the cache volume
        // is disposable, canonical keys live in the DB).
        try {
          await this.walletRpc("open_wallet", { filename, password });
        } catch {
          throw new Error(
            `monero wallet cache file cannot be opened or regenerated (${openError.message}); ` +
              "clear the monero-wallet-rpc wallet cache volume to force rehydration from the vault's canonical keys",
          );
        }
      }
    }
    // Unconditional dual-derivation check: the opened wallet's primary
    // (account 0) address must match the vault's canonical address.
    const addressResult = (await this.walletRpc("get_address", {
      account_index: 0,
      address_index: [0],
    })) as Record<string, unknown>;
    if (addressResult.address !== payload.address) {
      await this.closeWalletQuietly();
      throw new Error(
        "monero wallet cache address does not match the vault's canonical address — refusing to proceed",
      );
    }
  }

  private async closeWalletQuietly(): Promise<void> {
    try {
      await this.walletRpc("close_wallet", {});
    } catch {
      // No wallet open (or already closed) — nothing to do.
    }
  }

  private async walletRpc(method: string, params: unknown): Promise<unknown> {
    const body = stringifyWithBigints({
      jsonrpc: "2.0",
      id: "0",
      method,
      params,
    });
    const uri = new URL(this.rpcUrl).pathname || "/json_rpc";
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    let response = await this.doFetch(method, headers, body);
    if (response.status === 401 && this.login) {
      const challenge = response.headers.get("www-authenticate");
      if (!challenge || !/^digest/i.test(challenge)) {
        throw new MoneroRpcError(
          method,
          "wallet-rpc requires an unsupported auth scheme",
        );
      }
      headers.Authorization = buildDigestAuthorization(
        parseDigestChallenge(challenge),
        this.login.username,
        this.login.password,
        "POST",
        uri,
      );
      response = await this.doFetch(method, headers, body);
    }
    if (response.status === 401) {
      throw new MoneroRpcError(method, "wallet-rpc authentication failed");
    }
    if (!response.ok) {
      throw new MoneroRpcError(
        method,
        `wallet-rpc returned HTTP ${response.status}`,
      );
    }
    const parsed = parseWithBigIntegers(await response.text()) as {
      result?: unknown;
      error?: { code?: number; message?: string };
    };
    if (parsed.error) {
      throw new MoneroRpcError(
        method,
        parsed.error.message ?? "unknown wallet-rpc error",
        parsed.error.code,
      );
    }
    if (parsed.result === undefined) {
      throw new MoneroRpcError(
        method,
        "wallet-rpc response is missing a result",
      );
    }
    return parsed.result;
  }

  private async doFetch(
    method: string,
    headers: Record<string, string>,
    body: string,
  ): Promise<Response> {
    try {
      return await this.fetchFn(this.rpcUrl, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new MoneroRpcError(method, errorMessage(error));
    }
  }
}

function isWalletExistsError(error: unknown): boolean {
  return (
    error instanceof MoneroRpcError &&
    error.method === "generate_from_keys" &&
    /already exists/i.test(error.message)
  );
}

/**
 * Wallet cache file password, derived from the spend key so rehydration needs
 * no extra stored secret. The cache file only ever lives on the sidecar's
 * private volume; the canonical key material stays AAD-encrypted in the DB.
 */
function walletCachePassword(spendKeyHex: string): string {
  return createHmac("sha256", decodeHex(spendKeyHex))
    .update("steward-monero-wallet-cache-v1")
    .digest("hex");
}

// ─── Env wiring ───────────────────────────────────────────────────────────────

export interface MoneroEnv {
  STEWARD_MONERO_WALLET_RPC_URL?: string;
  STEWARD_MONERO_WALLET_RPC_LOGIN?: string;
  STEWARD_MONERO_DAEMON_URL?: string;
  STEWARD_MONERO_NETWORK?: string;
}

/**
 * Build the backend from environment configuration, or return null when
 * Monero support is not configured (callers fail closed on null).
 */
export function createMoneroBackendFromEnv(
  env: MoneroEnv = process.env as MoneroEnv,
): MoneroWalletBackend | null {
  const rpcUrl = env.STEWARD_MONERO_WALLET_RPC_URL;
  if (!rpcUrl) return null;
  const daemonUrl = env.STEWARD_MONERO_DAEMON_URL;
  if (!daemonUrl) {
    throw new MoneroNotConfiguredError(
      "STEWARD_MONERO_DAEMON_URL is required.",
    );
  }
  const network = env.STEWARD_MONERO_NETWORK ?? "mainnet";
  if (network !== "mainnet" && network !== "stagenet") {
    throw new Error("STEWARD_MONERO_NETWORK must be mainnet or stagenet");
  }
  return new MoneroWalletRpcBackend({
    network,
    rpcUrl,
    rpcLogin: env.STEWARD_MONERO_WALLET_RPC_LOGIN,
    daemonUrl,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
