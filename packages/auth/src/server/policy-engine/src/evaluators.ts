import { ed25519 } from "@noble/curves/ed25519";
import { keccak_256 } from "@noble/hashes/sha3";
import { sha256 } from "@noble/hashes/sha256";
import {
  type AllowedChainsConfig,
  type ApprovedAddressesConfig,
  type AutoApproveConfig,
  type ConditionSetConfig,
  type ContractAllowlistConfig,
  chainFromNumeric,
  type PolicyResult,
  type PolicyRule,
  type PriceOracle,
  type RateLimitConfig,
  type RawSigningChainConditionConfig,
  rawSigningChainSupport,
  type SignRequest,
  type SpendingLimitConfig,
  type TimeWindowConfig,
  type TypedDataConditionConfig,
  type TypedDataDomain,
  type TypedDataField,
  type TypedDataMessageCondition,
  toCaip2,
} from "../../shared/src/index.ts";
import {
  type AggregationLookup,
  evaluateAggregation,
} from "./evaluators/aggregation";
import { evaluateLeverageCap } from "./evaluators/leverage-cap";
import { evaluateReputationScaling } from "./evaluators/reputation-scaling";
import { evaluateReputationThreshold } from "./evaluators/reputation-threshold";
import { evaluateVenueAllowlist } from "./evaluators/venue-allowlist";
import type { ManualApprovalSignal } from "./manual-approval";
import { evaluateRegisteredPolicy } from "./policy-rule-registry";

const MAX_UINT256_DECIMAL =
  "115792089237316195423570985008687907853269984665640564039457584007913129639935";
const MAX_UINT256_DECIMAL_DIGITS = 78;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function usdMicrosToConservativeNumber(value: bigint): number {
  if (value < 0n) return Number.NaN;
  // Number conversion above MAX_SAFE_INTEGER may round down. A finite policy
  // limit cannot safely admit such a balance, so reject it via Infinity.
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) return Number.POSITIVE_INFINITY;
  const converted = Number(value) / 1_000_000;
  if (converted === 0) return 0;

  // Division can round a safe integer micros value downward (for example,
  // 9007199254740983n). Compare the exact IEEE-754 rational against the source
  // integer and advance one ULP only when needed; always advancing would deny
  // an exact cap boundary that converted without loss.
  const bits = new DataView(new ArrayBuffer(8));
  bits.setFloat64(0, converted, false);
  const encoded = bits.getBigUint64(0, false);
  const exponentBits = Number((encoded >> 52n) & 0x7ffn);
  const fraction = encoded & ((1n << 52n) - 1n);
  const significand = exponentBits === 0 ? fraction : (1n << 52n) | fraction;
  const exponent = (exponentBits === 0 ? -1022 : exponentBits - 1023) - 52;
  const scaledSignificand = significand * 1_000_000n;
  const roundedDown =
    exponent >= 0
      ? scaledSignificand << BigInt(exponent) < value
      : scaledSignificand < value << BigInt(-exponent);
  if (!roundedDown) return converted;

  bits.setBigUint64(0, encoded + 1n, false);
  return bits.getFloat64(0, false);
}

function isEvmAddress(value: unknown): value is string {
  return typeof value === "string" && /^0x[a-f0-9]{40}$/i.test(value);
}

type PolicyAddressFamily = "evm" | "solana" | "bitcoin" | "monero";

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const MONERO_BLOCK_BYTES = [0, 2, 3, 5, 6, 7, 9, 10, 11] as const;

function decodeBase58(value: string): Uint8Array | null {
  if (!value) return null;
  let leadingZeroes = 0;
  while (value[leadingZeroes] === "1") leadingZeroes += 1;
  let number = 0n;
  for (const character of value) {
    const digit = BASE58_ALPHABET.indexOf(character);
    if (digit < 0) return null;
    number = number * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (number > 0n) {
    bytes.unshift(Number(number & 0xffn));
    number >>= 8n;
  }
  return Uint8Array.from([...new Array(leadingZeroes).fill(0), ...bytes]);
}

function isSolanaAddress(value: string): boolean {
  return (
    /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value) &&
    decodeBase58(value)?.length === 32
  );
}

function bech32Polymod(values: number[]): number {
  const generators = [
    0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3,
  ];
  let checksum = 1;
  for (const value of values) {
    const top = checksum >>> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    for (let bit = 0; bit < 5; bit += 1) {
      if ((top >>> bit) & 1) checksum ^= generators[bit] as number;
    }
  }
  return checksum >>> 0;
}

function decodeBech32Address(
  value: string,
): { hrp: string; version: number; program: Uint8Array } | null {
  if (
    value.length < 8 ||
    value.length > 90 ||
    (value !== value.toLowerCase() && value !== value.toUpperCase())
  ) {
    return null;
  }
  const normalized = value.toLowerCase();
  const separator = normalized.lastIndexOf("1");
  if (separator < 1 || separator + 7 > normalized.length) return null;
  const hrp = normalized.slice(0, separator);
  const alphabet = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  const words: number[] = [];
  for (const character of normalized.slice(separator + 1)) {
    const word = alphabet.indexOf(character);
    if (word < 0) return null;
    words.push(word);
  }
  const expanded = [
    ...[...hrp].map((character) => character.charCodeAt(0) >>> 5),
    0,
    ...[...hrp].map((character) => character.charCodeAt(0) & 31),
  ];
  const encoding = bech32Polymod([...expanded, ...words]);
  if (encoding !== 1 && encoding !== 0x2bc830a3) return null;
  const payload = words.slice(0, -6);
  const version = payload[0];
  if (version === undefined || version > 16) return null;
  let accumulator = 0;
  let bits = 0;
  const program: number[] = [];
  for (const word of payload.slice(1)) {
    accumulator = (accumulator << 5) | word;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      program.push((accumulator >>> bits) & 0xff);
    }
  }
  if (bits >= 5 || ((accumulator << (8 - bits)) & 0xff) !== 0) return null;
  if (program.length < 2 || program.length > 40) return null;
  if (
    version === 0 &&
    (encoding !== 1 || (program.length !== 20 && program.length !== 32))
  )
    return null;
  if (version > 0 && encoding !== 0x2bc830a3) return null;
  return { hrp, version, program: Uint8Array.from(program) };
}

function isBitcoinAddress(value: string, testnet: boolean): boolean {
  const bech32 = decodeBech32Address(value);
  if (bech32) return testnet ? bech32.hrp === "tb" : bech32.hrp === "bc";
  if (!/^[123mn2][1-9A-HJ-NP-Za-km-z]{25,34}$/.test(value)) return false;
  const decoded = decodeBase58(value);
  if (!decoded || decoded.length !== 25) return false;
  const expected = sha256(sha256(decoded.subarray(0, 21))).subarray(0, 4);
  if (!expected.every((byte, index) => byte === decoded[21 + index]))
    return false;
  return testnet
    ? decoded[0] === 111 || decoded[0] === 196
    : decoded[0] === 0 || decoded[0] === 5;
}

function decodeMoneroBlock(
  value: string,
  byteLength: number,
): Uint8Array | null {
  let number = 0n;
  for (const character of value) {
    const digit = BASE58_ALPHABET.indexOf(character);
    if (digit < 0) return null;
    number = number * 58n + BigInt(digit);
  }
  const result = new Uint8Array(byteLength);
  for (let index = byteLength - 1; index >= 0; index -= 1) {
    result[index] = Number(number & 0xffn);
    number >>= 8n;
  }
  return number === 0n ? result : null;
}

function decodeMoneroAddress(value: string): Uint8Array | null {
  if (value.length !== 95 && value.length !== 106) return null;
  const fullBlocks = Math.floor(value.length / 11);
  const trailingCharacters = value.length % 11;
  const trailingBytes = MONERO_BLOCK_BYTES.indexOf(
    trailingCharacters as (typeof MONERO_BLOCK_BYTES)[number],
  );
  if (trailingBytes < 0) return null;
  const decoded = new Uint8Array(fullBlocks * 8 + trailingBytes);
  for (let index = 0; index < fullBlocks; index += 1) {
    const block = decodeMoneroBlock(
      value.slice(index * 11, (index + 1) * 11),
      8,
    );
    if (!block) return null;
    decoded.set(block, index * 8);
  }
  if (trailingBytes > 0) {
    const block = decodeMoneroBlock(
      value.slice(fullBlocks * 11),
      trailingBytes,
    );
    if (!block) return null;
    decoded.set(block, fullBlocks * 8);
  }
  return decoded;
}

function isMoneroAddress(value: string, stagenet: boolean): boolean {
  const decoded = decodeMoneroAddress(value);
  if (!decoded || (decoded.length !== 69 && decoded.length !== 77))
    return false;
  const body = decoded.subarray(0, -4);
  const checksum = keccak_256(body).subarray(0, 4);
  if (
    !checksum.every(
      (byte, index) => byte === decoded[decoded.length - 4 + index],
    )
  )
    return false;
  const standardPrefixes = stagenet ? [24, 25, 36] : [18, 19, 42];
  const prefix = decoded[0] as number;
  if (!standardPrefixes.includes(prefix)) return false;
  const integrated = prefix === (stagenet ? 25 : 19);
  if (decoded.length !== (integrated ? 77 : 69)) return false;
  try {
    for (const encodedPoint of [
      decoded.subarray(1, 33),
      decoded.subarray(33, 65),
    ]) {
      const point = ed25519.ExtendedPoint.fromHex(encodedPoint);
      if (point.is0() || point.isSmallOrder() || !point.isTorsionFree())
        return false;
    }
    return true;
  } catch {
    return false;
  }
}

function isPolicyAddressForChain(
  value: unknown,
  chainId: number,
): value is string {
  if (typeof value !== "string") return false;
  const chain = chainFromNumeric(chainId);
  switch (chain?.family) {
    case "evm":
      return isEvmAddress(value);
    case "solana":
      return isSolanaAddress(value);
    case "bitcoin":
      return isBitcoinAddress(value, chain.testnet);
    case "monero":
      return isMoneroAddress(value, chain.testnet);
    default:
      return false;
  }
}

function isRecognizedPolicyAddress(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (isEvmAddress(value) ||
      isSolanaAddress(value) ||
      isBitcoinAddress(value, false) ||
      isBitcoinAddress(value, true) ||
      isMoneroAddress(value, false) ||
      isMoneroAddress(value, true))
  );
}

function normalizePolicyAddress(
  value: string,
  family: PolicyAddressFamily,
): string {
  return family === "evm" ||
    (family === "bitcoin" && /^(?:bc1|tb1|bcrt1)/i.test(value))
    ? value.toLowerCase()
    : value;
}

export interface EvaluatorContext {
  request: SignRequest;
  recentTxCount24h: number;
  recentTxCount1h: number;
  /**
   * Rolling spend sums in the base unit of `request.chainId` ONLY (wei for
   * EVM, lamports for Solana, piconero for Monero...). Callers MUST scope
   * these counters to the request's chain: a cross-chain sum mixes
   * incomparable units, and the USD path re-prices it at this request's chain
   * price — silently under- or over-enforcing the cap (SEC-039).
   */
  spentToday: bigint;
  spentThisWeek: bigint;
  /**
   * Additional committed or conservatively-pending spend denominated in USD
   * micros. This is kept separate from the chain-native counters above: adding
   * USDC base units (or a quoted native equivalent) to wei/lamports would
   * corrupt raw-denominated limits. USD limits apply these amounts
   * conjunctively after pricing the chain-native counters.
   */
  additionalUsdSpentTodayMicros?: bigint;
  additionalUsdSpentThisWeekMicros?: bigint;
  /** Optional price oracle for USD-based policy evaluation */
  priceOracle?: PriceOracle;
  /** Optional reputation score for reputation-based policies */
  reputationScore?: number;
  /**
   * Sprint 4: trading venue the request is destined for. Required by the
   * `venue-allowlist` evaluator. Trade-sessions sets this from the venue
   * adapter dispatch step; non-trade signing requests leave it undefined.
   */
  venue?: string;
  /**
   * Sprint 4: requested leverage multiple (e.g. 2 = 2x). Required by the
   * `leverage-cap` evaluator. Undefined for non-leveraged trades and for
   * spot transfers.
   */
  leverage?: number;
  /**
   * Optional pre-computed USD value of the action. Trade-sessions can
   * populate this so evaluators don't all re-quote the oracle.
   */
  valueUsd?: number;
  conditionSets?: Record<string, string[]>;
  /**
   * Authoritative rolling-aggregate lookup for `aggregation` policies. Callers
   * wire this from a server-side provider (Redis rolling counters / tx
   * history). When absent, aggregation policies fail closed (deny).
   */
  aggregations?: AggregationLookup;
  /**
   * Decoded EIP-712 typed-data payload for `typed-data` policies. Populated
   * ONLY by the typed-data signing route; absent on ordinary transaction
   * signs. A `typed-data` policy is "not applicable" (passes) when this is
   * undefined, so it cannot interfere with normal tx signing.
   */
  typedData?: {
    domain: TypedDataDomain;
    types: Record<string, TypedDataField[]>;
    primaryType: string;
    value: Record<string, unknown>;
  };
  rawSigning?: {
    chain: string;
    curve: string;
  };
  /**
   * Capability-invoke context for `capability-intent` policies. Populated ONLY
   * by the capability invoke route (W-1c); absent on ordinary signing requests,
   * so a `capability-intent` policy is "not applicable" (passes) when this is
   * undefined. Symmetry with `typedData`: capability policies cannot interfere
   * with transaction signing, and transaction policies cannot interfere with
   * capability invokes.
   */
  capability?: {
    name: string;
    args: Record<string, unknown>;
    host: string;
    path: string;
    method: string;
    /** Immutable server-supplied instant for time-window constraints. */
    evaluatedAt?: string;
  };
  /**
   * Rolling count of capability INVOKES in the trailing hour (distinct from
   * `recentTxCount1h`, which counts transaction signs). Populated ONLY by the
   * capability invoke route (W-1c) alongside `capability`. When a
   * `capability-intent` rule sets `constraints.maxCallsPerHour` but this count
   * is absent, the rule FAILS CLOSED (deny) rather than borrowing the tx
   * counter, so an unwired invoke path can never silently pass a rate cap.
   */
  capabilityInvokeCount1h?: number;
}

function parseUint256Decimal(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const normalized = value.replace(/^0+/, "") || "0";
  if (normalized.length > MAX_UINT256_DECIMAL_DIGITS) return null;
  if (
    normalized.length === MAX_UINT256_DECIMAL_DIGITS &&
    normalized > MAX_UINT256_DECIMAL
  ) {
    return null;
  }
  return BigInt(normalized);
}

/**
 * Evaluate a single policy rule against a transaction request.
 * Returns pass/fail with reason, plus an optional `requiresManualApproval`
 * signal (see `./manual-approval`) that the engine honours to route a
 * non-passing "hard" policy to the manual-approval queue instead of a hard
 * deny. The signal is optional, so the return value is structurally still a
 * `PolicyResult`; evaluators that never set it behave exactly as before.
 *
 * Now async to support USD-based evaluations that need price lookups.
 */
export async function evaluatePolicy(
  rule: PolicyRule,
  ctx: EvaluatorContext,
): Promise<PolicyResult & ManualApprovalSignal> {
  // A non-boolean `enabled` is malformed config, not "disabled": fail closed
  // rather than let a hand-authored rule silently pass as disabled (SEC-103).
  if (typeof rule.enabled !== "boolean") {
    return {
      policyId: rule.id,
      type: rule.type,
      passed: false,
      reason: "Policy enabled flag must be a boolean",
    };
  }
  if (!rule.enabled) {
    return {
      policyId: rule.id,
      type: rule.type,
      passed: true,
      reason: "Policy disabled",
    };
  }

  switch (rule.type) {
    case "spending-limit":
      return evaluateSpendingLimit(rule, ctx);
    case "approved-addresses":
      return evaluateApprovedAddresses(rule, ctx);
    case "auto-approve-threshold":
      return evaluateAutoApprove(rule, ctx);
    case "rate-limit":
      return evaluateRateLimit(rule, ctx);
    case "time-window":
      return evaluateTimeWindow(rule, ctx);
    case "allowed-chains":
      return evaluateAllowedChains(rule, ctx);
    case "condition-set":
      return evaluateConditionSet(rule, ctx);
    case "aggregation":
      return evaluateAggregation(rule, {
        request: ctx.request,
        aggregations: ctx.aggregations,
        priceOracle: ctx.priceOracle,
      });
    case "contract-allowlist":
      return evaluateContractAllowlist(rule, ctx);
    case "typed-data":
      return evaluateTypedData(rule, ctx);
    case "raw-signing-chain":
      return evaluateRawSigningChain(rule, ctx);
    case "reputation-threshold":
      return evaluateReputationThreshold(rule, {
        reputationScore: ctx.reputationScore,
      });
    case "reputation-scaling": {
      const txValue = parseUint256Decimal(ctx.request.value);
      if (txValue === null) {
        return {
          policyId: rule.id,
          type: rule.type,
          passed: false,
          reason: "Transaction value must be a uint256 wei string",
        };
      }
      return evaluateReputationScaling(rule, {
        reputationScore: ctx.reputationScore,
        txValue,
      });
    }
    case "venue-allowlist":
      return evaluateVenueAllowlist(rule, { venue: ctx.venue });
    case "leverage-cap":
      return evaluateLeverageCap(rule, { leverage: ctx.leverage });
    default: {
      // FALLTHROUGH FOR NON-CORE RULE TYPES ONLY. Every core type is handled by a
      // `case` above; control reaches here ONLY for a rule type the core does not
      // own. Consult the plugin policy-rule registry (Phase 2b): if a plugin
      // registered an evaluator for this type, run it; otherwise preserve the
      // historical "Unknown policy type" deny. Core decisions are byte-identical
      // because no core type ever reaches this arm.
      const registered = await evaluateRegisteredPolicy(rule, ctx);
      if (registered) return registered;
      return {
        policyId: rule.id,
        type: rule.type,
        passed: false,
        reason: `Unknown policy type: ${rule.type}`,
      };
    }
  }
}

function normalizePolicyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim().toLowerCase()
    : null;
}

function evaluateRawSigningChain(
  rule: PolicyRule,
  ctx: EvaluatorContext,
): PolicyResult {
  const base = { policyId: rule.id, type: rule.type } as const;
  if (!ctx.rawSigning) {
    return {
      ...base,
      passed: true,
      reason: "Not a raw-digest signing request",
    };
  }
  const config = rule.config as unknown as RawSigningChainConditionConfig;
  const chain = normalizePolicyString(ctx.rawSigning.chain);
  const curve = normalizePolicyString(ctx.rawSigning.curve);
  if (!chain || !curve) {
    return {
      ...base,
      passed: false,
      reason: "Raw signing chain and curve are required",
    };
  }
  const support = rawSigningChainSupport(chain);
  const requireSupported = config.requireSupported !== false;
  if (requireSupported && (!support || !support.supported)) {
    return {
      ...base,
      passed: false,
      reason: `Raw signing chain ${chain} is not supported`,
    };
  }
  if (support && support.curve !== curve) {
    return {
      ...base,
      passed: false,
      reason: `Raw signing chain ${chain} requires ${support.curve}, not ${curve}`,
    };
  }
  const allowedChains = (config.allowedChains ?? [])
    .map(normalizePolicyString)
    .filter(Boolean);
  if (allowedChains.length > 0 && !allowedChains.includes(chain)) {
    return {
      ...base,
      passed: false,
      reason: `Raw signing chain ${chain} is not in the allowed list`,
    };
  }
  const blockedChains = (config.blockedChains ?? [])
    .map(normalizePolicyString)
    .filter(Boolean);
  if (blockedChains.includes(chain)) {
    return {
      ...base,
      passed: false,
      reason: `Raw signing chain ${chain} is blocked`,
    };
  }
  const allowedCurves = (config.allowedCurves ?? [])
    .map(normalizePolicyString)
    .filter(Boolean);
  if (allowedCurves.length > 0 && !allowedCurves.includes(curve)) {
    return {
      ...base,
      passed: false,
      reason: `Raw signing curve ${curve} is not in the allowed list`,
    };
  }
  return {
    ...base,
    passed: true,
    reason: `Raw signing chain ${chain} on ${curve} is allowed`,
  };
}

/**
 * Normalize spending-limit config to the canonical format (maxPerTx/maxPerDay/maxPerWeek).
 * Accepts both the canonical format and the simplified maxAmount/period format.
 */
function hasOwnDefined(record: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(record, key) && record[key] !== undefined;
}

function normalizeSpendingLimitConfig(
  config: Record<string, unknown>,
): SpendingLimitConfig {
  const simplifiedWeiCaps = (): Pick<
    SpendingLimitConfig,
    "maxPerTx" | "maxPerDay" | "maxPerWeek"
  > => {
    // Wei values are an exact-integer contract. Never coerce JSON numbers:
    // values above Number.MAX_SAFE_INTEGER have already lost precision before
    // BigInt sees them. Malformed legacy fields flow to the common uint256
    // parser below and fail closed.
    const maxAmount =
      typeof config.maxAmount === "string" ? config.maxAmount : "";
    const period =
      config.period === undefined
        ? "day"
        : typeof config.period === "string"
          ? config.period.toLowerCase()
          : "";

    switch (period) {
      case "tx":
      case "transaction":
        return {
          maxPerTx: maxAmount,
          maxPerDay: MAX_UINT256_DECIMAL,
          maxPerWeek: MAX_UINT256_DECIMAL,
        };
      case "day":
      case "daily":
        return {
          maxPerTx: maxAmount,
          maxPerDay: maxAmount,
          maxPerWeek: MAX_UINT256_DECIMAL,
        };
      case "week":
      case "weekly":
        return {
          maxPerTx: maxAmount,
          maxPerDay: MAX_UINT256_DECIMAL,
          maxPerWeek: maxAmount,
        };
      default:
        // Preserve the historical fail-safe fallback: an unknown period is
        // treated as a per-transaction cap rather than as unbounded spend.
        return {
          maxPerTx: maxAmount,
          maxPerDay: MAX_UINT256_DECIMAL,
          maxPerWeek: MAX_UINT256_DECIMAL,
        };
    }
  };

  const hasCanonicalWeiCap =
    hasOwnDefined(config, "maxPerTx") ||
    hasOwnDefined(config, "maxPerDay") ||
    hasOwnDefined(config, "maxPerWeek");
  const hasUsdCap =
    hasOwnDefined(config, "maxPerTxUsd") ||
    hasOwnDefined(config, "maxPerDayUsd") ||
    hasOwnDefined(config, "maxPerWeekUsd");

  // Any canonical wei or USD field selects the canonical format. Missing wei
  // caps are unbounded, but every explicitly declared cap must survive
  // normalization. Checking only the per-tx fields caused a mixed config such
  // as { maxPerDay, maxPerDayUsd } to take the USD-only branch and silently
  // discard maxPerDay.
  if (hasCanonicalWeiCap || hasUsdCap) {
    // Legacy policies can legitimately gain canonical or USD fields one at a
    // time. Preserve the legacy limits for every dimension that was not
    // explicitly replaced; treating the first canonical wei field as a switch
    // for the whole representation could silently erase the other legacy caps.
    const inheritedWeiCaps = hasOwnDefined(config, "maxAmount")
      ? simplifiedWeiCaps()
      : {
          maxPerTx: MAX_UINT256_DECIMAL,
          maxPerDay: MAX_UINT256_DECIMAL,
          maxPerWeek: MAX_UINT256_DECIMAL,
        };
    const weiCaps = {
      maxPerTx: hasOwnDefined(config, "maxPerTx")
        ? typeof config.maxPerTx === "string"
          ? config.maxPerTx
          : ""
        : inheritedWeiCaps.maxPerTx,
      maxPerDay: hasOwnDefined(config, "maxPerDay")
        ? typeof config.maxPerDay === "string"
          ? config.maxPerDay
          : ""
        : inheritedWeiCaps.maxPerDay,
      maxPerWeek: hasOwnDefined(config, "maxPerWeek")
        ? typeof config.maxPerWeek === "string"
          ? config.maxPerWeek
          : ""
        : inheritedWeiCaps.maxPerWeek,
    };
    return {
      ...weiCaps,
      maxPerTxUsd: hasOwnDefined(config, "maxPerTxUsd")
        ? (config.maxPerTxUsd as number)
        : undefined,
      maxPerDayUsd: hasOwnDefined(config, "maxPerDayUsd")
        ? (config.maxPerDayUsd as number)
        : undefined,
      maxPerWeekUsd: hasOwnDefined(config, "maxPerWeekUsd")
        ? (config.maxPerWeekUsd as number)
        : undefined,
    };
  }

  // Convert from maxAmount/period format
  return simplifiedWeiCaps();
}

/**
 * Check if the spending limit config has any USD-based limits.
 */
function hasUsdLimits(config: SpendingLimitConfig): boolean {
  return (
    config.maxPerTxUsd !== undefined ||
    config.maxPerDayUsd !== undefined ||
    config.maxPerWeekUsd !== undefined
  );
}

function invalidUsdLimit(config: SpendingLimitConfig): string | null {
  for (const field of [
    "maxPerTxUsd",
    "maxPerDayUsd",
    "maxPerWeekUsd",
  ] as const) {
    const value = config[field];
    if (
      value !== undefined &&
      (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    ) {
      return field;
    }
  }
  return null;
}

async function evaluateSpendingLimit(
  rule: PolicyRule,
  ctx: EvaluatorContext,
): Promise<PolicyResult> {
  const base = { policyId: rule.id, type: rule.type } as const;
  const rawConfig: unknown = rule.config;
  if (
    typeof rawConfig !== "object" ||
    rawConfig === null ||
    Array.isArray(rawConfig)
  ) {
    return {
      ...base,
      passed: false,
      reason:
        "Spending limit requires a non-empty canonical or legacy limit config",
    };
  }
  const configRecord = rawConfig as Record<string, unknown>;
  if (
    ![
      "maxPerTx",
      "maxPerDay",
      "maxPerWeek",
      "maxPerTxUsd",
      "maxPerDayUsd",
      "maxPerWeekUsd",
      "maxAmount",
    ].some((field) => hasOwnDefined(configRecord, field))
  ) {
    return {
      ...base,
      passed: false,
      reason:
        "Spending limit requires a non-empty canonical or legacy limit config",
    };
  }
  const config = normalizeSpendingLimitConfig(configRecord);
  const txValue = parseUint256Decimal(ctx.request.value);
  if (txValue === null) {
    return {
      ...base,
      passed: false,
      reason: "Transaction value must be a uint256 wei string",
    };
  }

  // ── USD-based evaluation (preferred when available) ─────────────────────────
  if (hasUsdLimits(config)) {
    const invalidField = invalidUsdLimit(config);
    if (invalidField) {
      return {
        ...base,
        passed: false,
        reason: `${invalidField} must be a non-negative finite number`,
      };
    }
    if (!ctx.priceOracle) {
      return {
        ...base,
        passed: false,
        reason:
          "USD spending limit cannot be evaluated because no price oracle is available",
      };
    }
    const chainId = ctx.request.chainId;
    const txUsd = await ctx.priceOracle.weiToUsd(ctx.request.value, chainId);

    if (txUsd === null || !Number.isFinite(txUsd) || txUsd < 0) {
      return {
        ...base,
        passed: false,
        reason: `USD spending limit cannot be evaluated for chain ${chainId}`,
      };
    }

    // Per-transaction USD limit
    if (config.maxPerTxUsd !== undefined && txUsd > config.maxPerTxUsd) {
      return {
        ...base,
        passed: false,
        reason: `Transaction value $${txUsd.toFixed(2)} exceeds per-tx USD limit $${config.maxPerTxUsd}`,
      };
    }

    // Daily USD limit - convert spentToday from wei to USD
    if (config.maxPerDayUsd !== undefined) {
      const nativeSpentTodayUsd = await ctx.priceOracle.weiToUsd(
        ctx.spentToday.toString(),
        chainId,
      );
      const additionalUsd = usdMicrosToConservativeNumber(
        ctx.additionalUsdSpentTodayMicros ?? 0n,
      );
      const spentTodayUsd =
        nativeSpentTodayUsd === null
          ? null
          : nativeSpentTodayUsd + additionalUsd;
      if (
        spentTodayUsd === null ||
        !Number.isFinite(spentTodayUsd) ||
        spentTodayUsd < 0
      ) {
        return {
          ...base,
          passed: false,
          reason: `Daily USD spending limit cannot be evaluated for chain ${chainId}`,
        };
      }
      if (spentTodayUsd + txUsd > config.maxPerDayUsd) {
        return {
          ...base,
          passed: false,
          reason: `Would exceed daily USD spending limit $${config.maxPerDayUsd} (spent today: $${spentTodayUsd.toFixed(2)} + this tx: $${txUsd.toFixed(2)})`,
        };
      }
    }

    // Weekly USD limit - convert spentThisWeek from wei to USD
    if (config.maxPerWeekUsd !== undefined) {
      const nativeSpentWeekUsd = await ctx.priceOracle.weiToUsd(
        ctx.spentThisWeek.toString(),
        chainId,
      );
      const additionalUsd = usdMicrosToConservativeNumber(
        ctx.additionalUsdSpentThisWeekMicros ?? 0n,
      );
      const spentWeekUsd =
        nativeSpentWeekUsd === null ? null : nativeSpentWeekUsd + additionalUsd;
      if (
        spentWeekUsd === null ||
        !Number.isFinite(spentWeekUsd) ||
        spentWeekUsd < 0
      ) {
        return {
          ...base,
          passed: false,
          reason: `Weekly USD spending limit cannot be evaluated for chain ${chainId}`,
        };
      }
      if (spentWeekUsd + txUsd > config.maxPerWeekUsd) {
        return {
          ...base,
          passed: false,
          reason: `Would exceed weekly USD spending limit $${config.maxPerWeekUsd} (spent this week: $${spentWeekUsd.toFixed(2)} + this tx: $${txUsd.toFixed(2)})`,
        };
      }
    }

    // USD and wei-denominated caps in the same config are conjunctive. Continue
    // into wei evaluation; undeclared wei fields normalize to MAX_UINT256.
    if (
      !hasOwnDefined(configRecord, "maxPerTx") &&
      !hasOwnDefined(configRecord, "maxPerDay") &&
      !hasOwnDefined(configRecord, "maxPerWeek") &&
      !hasOwnDefined(configRecord, "maxAmount")
    ) {
      return { ...base, passed: true };
    }
  }

  // ── Wei-based evaluation (legacy / fallback, and conjunctive with USD) ──────
  // ATOMICITY CONTRACT: this evaluator is pure — it compares the caller-supplied
  // spentToday/spentThisWeek counters and reserves/commits nothing. Concurrency
  // safety for the daily/weekly caps is the CALLER's responsibility: the spend
  // counters must be read and the resulting spend written inside one per-agent
  // serialization window. In the API that is `withAgentSpendLock` →
  // `pg_advisory_xact_lock(hashtext(agentId))` wrapping getTransactionStats()
  // and the transactions-table write. Without that lock two concurrent requests
  // can read the same spentToday and both pass, double-spending the cap.
  const maxPerTx = parseUint256Decimal(config.maxPerTx);
  const maxPerDay = parseUint256Decimal(config.maxPerDay);
  const maxPerWeek = parseUint256Decimal(config.maxPerWeek);
  if (maxPerTx === null || maxPerDay === null || maxPerWeek === null) {
    return {
      ...base,
      passed: false,
      reason: "Spending limit wei values must be uint256 strings",
    };
  }

  if (txValue > maxPerTx) {
    return {
      ...base,
      passed: false,
      reason: `Transaction value ${txValue} exceeds per-tx limit ${config.maxPerTx}`,
    };
  }

  if (ctx.spentToday + txValue > maxPerDay) {
    return {
      ...base,
      passed: false,
      reason: `Would exceed daily spending limit (${config.maxPerDay})`,
    };
  }

  if (ctx.spentThisWeek + txValue > maxPerWeek) {
    return {
      ...base,
      passed: false,
      reason: `Would exceed weekly spending limit (${config.maxPerWeek})`,
    };
  }

  return { ...base, passed: true };
}

function evaluateApprovedAddresses(
  rule: PolicyRule,
  ctx: EvaluatorContext,
): PolicyResult {
  const rawConfig: unknown = rule.config;
  const base = { policyId: rule.id, type: rule.type } as const;

  // Validate the complete runtime shape, not just the outer array: a hand-edited
  // row containing `null`/numbers used to throw during normalization, while an
  // unknown mode silently fell into blacklist semantics and could pass.
  if (
    !isRecord(rawConfig) ||
    !Array.isArray(rawConfig.addresses) ||
    !rawConfig.addresses.every((address) => typeof address === "string") ||
    (rawConfig.mode !== "whitelist" && rawConfig.mode !== "blacklist")
  ) {
    return {
      ...base,
      passed: false,
      reason:
        "Approved addresses must be an array of strings with a valid mode",
    };
  }
  const config = rawConfig as unknown as ApprovedAddressesConfig;

  const targetAddress = getApprovedAddressTarget(ctx.request);
  if (!targetAddress) {
    return {
      ...base,
      passed: false,
      reason: "No destination address found for approved-addresses policy",
    };
  }

  const family = chainFromNumeric(ctx.request.chainId)?.family;
  if (!family || !isPolicyAddressForChain(targetAddress, ctx.request.chainId)) {
    return {
      ...base,
      passed: false,
      reason: "Approved addresses must match the destination address family",
    };
  }
  if (!config.addresses.every(isRecognizedPolicyAddress)) {
    return {
      ...base,
      passed: false,
      reason: "Approved addresses contain an invalid address",
    };
  }

  const target = normalizePolicyAddress(targetAddress, family);
  const listed = config.addresses
    .filter((address) => isPolicyAddressForChain(address, ctx.request.chainId))
    .map((address) => normalizePolicyAddress(address, family));
  const mode = config.mode;

  if (mode === "whitelist") {
    if (!listed.includes(target)) {
      return {
        ...base,
        passed: false,
        reason: `Destination address ${targetAddress} not in whitelist`,
      };
    }
  } else {
    if (listed.includes(target)) {
      return {
        ...base,
        passed: false,
        reason: `Destination address ${targetAddress} is blacklisted`,
      };
    }
  }

  return { ...base, passed: true };
}

function getApprovedAddressTarget(request: SignRequest): string | undefined {
  // ONLY `request.to` is authoritative: it is the address the vault actually
  // signs for. Envelope shadow fields (`destination`, `action.destination`,
  // `withdraw.destination`) were once honored for a server-built withdraw flow
  // that now passes `to` explicitly — keeping them lets a caller smuggle a
  // whitelisted `destination` past the whitelist while signing to an arbitrary
  // `to` (SEC-001).
  return request.to;
}

async function evaluateAutoApprove(
  rule: PolicyRule,
  ctx: EvaluatorContext,
): Promise<PolicyResult> {
  const config = rule.config as unknown as AutoApproveConfig;
  const base = { policyId: rule.id, type: rule.type } as const;
  const txValue = parseUint256Decimal(ctx.request.value);
  if (txValue === null) {
    return {
      ...base,
      passed: false,
      reason: "Transaction value must be a uint256 wei string",
    };
  }

  // ── USD-based threshold (preferred) ─────────────────────────────────────────
  if (config.thresholdUsd !== undefined) {
    if (!ctx.priceOracle) {
      return {
        ...base,
        passed: false,
        reason:
          "Auto-approve USD threshold cannot be evaluated because no price oracle is available",
      };
    }
    const chainId = ctx.request.chainId;
    const txUsd = await ctx.priceOracle.weiToUsd(ctx.request.value, chainId);

    if (txUsd === null) {
      return {
        ...base,
        passed: false,
        reason: `Auto-approve USD threshold cannot be evaluated for chain ${chainId}`,
      };
    }
    if (txUsd <= config.thresholdUsd) {
      return {
        ...base,
        passed: true,
        reason: `$${txUsd.toFixed(2)} is below auto-approve threshold $${config.thresholdUsd}`,
      };
    }
    return {
      ...base,
      passed: false,
      reason: `Value $${txUsd.toFixed(2)} exceeds auto-approve USD threshold $${config.thresholdUsd}`,
    };
  }

  // ── Wei-based threshold (legacy / fallback) ─────────────────────────────────
  if (config.threshold !== undefined) {
    const threshold = parseUint256Decimal(config.threshold);
    if (threshold === null) {
      return {
        ...base,
        passed: false,
        reason: "Auto-approve threshold must be a uint256 wei string",
      };
    }
    if (txValue <= threshold) {
      return { ...base, passed: true, reason: "Below auto-approve threshold" };
    }
    return {
      ...base,
      passed: false,
      reason: `Value ${txValue} exceeds auto-approve threshold ${config.threshold}`,
    };
  }

  // An enabled but empty auto-approve rule must never become an unbounded
  // approval. Fail this soft policy so the engine routes the request to manual
  // approval instead.
  return {
    ...base,
    passed: false,
    reason: "Auto-approve threshold is not configured",
  };
}

function evaluateRateLimit(
  rule: PolicyRule,
  ctx: EvaluatorContext,
): PolicyResult {
  const config = rule.config as unknown as RateLimitConfig;
  const base = { policyId: rule.id, type: rule.type } as const;

  if (
    !Number.isSafeInteger(config.maxTxPerHour) ||
    config.maxTxPerHour < 0 ||
    !Number.isSafeInteger(config.maxTxPerDay) ||
    config.maxTxPerDay < 0
  ) {
    return {
      ...base,
      passed: false,
      reason: "Rate limits must be non-negative safe integers",
    };
  }

  if (ctx.recentTxCount1h >= config.maxTxPerHour) {
    return {
      ...base,
      passed: false,
      reason: `Hourly tx limit reached (${config.maxTxPerHour})`,
    };
  }

  if (ctx.recentTxCount24h >= config.maxTxPerDay) {
    return {
      ...base,
      passed: false,
      reason: `Daily tx limit reached (${config.maxTxPerDay})`,
    };
  }

  return { ...base, passed: true };
}

function evaluateTimeWindow(
  rule: PolicyRule,
  _ctx: EvaluatorContext,
): PolicyResult {
  const rawConfig: unknown = rule.config;
  const base = { policyId: rule.id, type: rule.type } as const;

  // Validate the nested runtime shape as well as the arrays. Otherwise a
  // hand-edited `allowedHours: [null]` throws inside `.some()` and bypasses the
  // structured-deny contract.
  if (
    !isRecord(rawConfig) ||
    !Array.isArray(rawConfig.allowedDays) ||
    !rawConfig.allowedDays.every(
      (day) =>
        typeof day === "number" &&
        Number.isInteger(day) &&
        day >= 0 &&
        day <= 6,
    ) ||
    !Array.isArray(rawConfig.allowedHours) ||
    !rawConfig.allowedHours.every(
      (window) =>
        isRecord(window) &&
        typeof window.start === "number" &&
        Number.isInteger(window.start) &&
        window.start >= 0 &&
        window.start <= 23 &&
        typeof window.end === "number" &&
        Number.isInteger(window.end) &&
        window.end >= 0 &&
        window.end <= 24,
    )
  ) {
    return {
      ...base,
      passed: false,
      reason:
        "Time-window allowedDays and allowedHours must be arrays of valid windows",
    };
  }
  const config = rawConfig as unknown as TimeWindowConfig;

  // An enabled time-window rule with NO windows at all is a misconfigured
  // no-op that would pass everything — fail closed instead (SEC-180),
  // consistent with venue-allowlist's empty-config deny. An empty array on
  // exactly ONE dimension still means "unconstrained on that dimension".
  if (config.allowedDays.length === 0 && config.allowedHours.length === 0) {
    return {
      ...base,
      passed: false,
      reason: "Time-window rule has no allowed days or hours configured",
    };
  }

  const now = new Date();
  const hour = now.getUTCHours();
  const day = now.getUTCDay();

  if (config.allowedDays.length > 0 && !config.allowedDays.includes(day)) {
    return {
      ...base,
      passed: false,
      reason: `Transactions not allowed on day ${day}`,
    };
  }

  if (config.allowedHours.length > 0) {
    const inWindow = config.allowedHours.some(
      (w) => hour >= w.start && hour < w.end,
    );
    if (!inWindow) {
      return {
        ...base,
        passed: false,
        reason: `Current hour ${hour} UTC not in allowed windows`,
      };
    }
  }

  return { ...base, passed: true };
}

/**
 * Allowed-chains policy: restricts transactions to a set of permitted CAIP-2 chain identifiers.
 */
function evaluateAllowedChains(
  rule: PolicyRule,
  ctx: EvaluatorContext,
): PolicyResult {
  const rawConfig: unknown = rule.config;
  const base = { policyId: rule.id, type: rule.type } as const;
  const chainId = ctx.request.chainId;

  if (
    !isRecord(rawConfig) ||
    !Array.isArray(rawConfig.chains) ||
    !rawConfig.chains.every(
      (chain) => typeof chain === "string" && chain.length > 0,
    )
  ) {
    return {
      ...base,
      passed: false,
      reason: "Allowed chains must be an array of CAIP-2 identifiers",
    };
  }
  const config = rawConfig as unknown as AllowedChainsConfig;

  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    return {
      ...base,
      passed: false,
      reason: "chainId is required for allowed-chains policy evaluation",
    };
  }

  const caip2 = toCaip2(chainId);
  if (!caip2) {
    return {
      ...base,
      passed: false,
      reason: `Chain ID ${chainId} is not a recognised chain and cannot be verified against the allowed-chains policy`,
    };
  }

  if (!config.chains.includes(caip2)) {
    return {
      ...base,
      passed: false,
      reason: `Chain ${caip2} (chainId ${chainId}) is not in the allowed chains list`,
    };
  }

  return { ...base, passed: true };
}

function extractConditionSetField(
  config: ConditionSetConfig,
  ctx: EvaluatorContext,
): string | null {
  switch (config.field ?? "ethereum_transaction.to") {
    case "to":
    case "ethereum_transaction.to":
    case "solana_system_program_instruction.Transfer.to":
      return ctx.request.to;
    case "chain_id":
    case "ethereum_transaction.chain_id":
      return String(ctx.request.chainId);
    case "value":
    case "ethereum_transaction.value":
      return ctx.request.value;
    case "data":
    case "ethereum_transaction.data":
      return ctx.request.data ?? "";
    default:
      return null;
  }
}

function normalizeConditionValue(
  value: string,
  caseSensitive: boolean | undefined,
): string {
  return caseSensitive ? value : value.toLowerCase();
}

function evaluateConditionSet(
  rule: PolicyRule,
  ctx: EvaluatorContext,
): PolicyResult {
  const config = rule.config as unknown as ConditionSetConfig;
  const base = { policyId: rule.id, type: rule.type } as const;

  if (!config.conditionSetId || typeof config.conditionSetId !== "string") {
    return { ...base, passed: false, reason: "conditionSetId is required" };
  }

  const values = ctx.conditionSets?.[config.conditionSetId];
  if (!values) {
    return {
      ...base,
      passed: false,
      reason: `Condition set ${config.conditionSetId} was not loaded for evaluation`,
    };
  }

  const operator = config.operator ?? "in_condition_set";
  if (operator !== "in_condition_set" && operator !== "not_in_condition_set") {
    return {
      ...base,
      passed: false,
      reason: `Unsupported condition set operator: ${String(operator)}`,
    };
  }

  const extracted = extractConditionSetField(config, ctx);
  if (extracted === null) {
    return {
      ...base,
      passed: false,
      reason: `Unsupported condition set field: ${String(config.field)}`,
    };
  }

  const target = normalizeConditionValue(extracted, config.caseSensitive);
  const listed = values.map((value) =>
    normalizeConditionValue(value, config.caseSensitive),
  );
  const contains = listed.includes(target);

  if (operator === "not_in_condition_set") {
    return contains
      ? {
          ...base,
          passed: false,
          reason: `Value ${target} is present in condition set ${config.conditionSetId}`,
        }
      : { ...base, passed: true };
  }

  if (!contains) {
    return {
      ...base,
      passed: false,
      reason: `Value ${target} is not present in condition set ${config.conditionSetId}`,
    };
  }

  return { ...base, passed: true };
}

function evaluateContractAllowlist(
  rule: PolicyRule,
  ctx: EvaluatorContext,
): PolicyResult {
  const config = rule.config as unknown as ContractAllowlistConfig;
  const base = { policyId: rule.id, type: rule.type } as const;
  const data = ctx.request.data;

  // SEC-183 (documented seam): a request with NO calldata is a plain native
  // transfer, and this rule does NOT gate it — it passes unconditionally,
  // regardless of the allowlist. This is intentional (the rule's job is
  // contract/selector gating) but a common misconfiguration seam: operators
  // who expect contract-allowlist to also constrain native sends MUST pair it
  // with an approved-addresses rule (note: the write validator restricts
  // approved-addresses to known chain address families and evaluates against
  // the request's chain family). Flipping this branch to deny would silently
  // break existing tenants that rely on the documented behavior, so the
  // decision to gate native transfers explicitly is deferred (see SEC-183).
  if (!data || data === "0x") {
    return {
      ...base,
      passed: true,
      reason:
        "No contract calldata: native transfer is not gated by contract-allowlist",
    };
  }

  if (!/^0x(?:[a-fA-F0-9]{2})+$/.test(data) || data.length < 10) {
    return {
      ...base,
      passed: false,
      reason: "Contract calldata must include a 4-byte function selector",
    };
  }

  const target = ctx.request.to.toLowerCase();
  const selector = data.slice(0, 10).toLowerCase();
  const contract = config.contracts?.find(
    (entry) => entry.address.toLowerCase() === target,
  );
  if (!contract) {
    return {
      ...base,
      passed: false,
      reason: `Contract ${ctx.request.to} is not in the contract allowlist`,
    };
  }

  const allowedSelectors = contract.selectors.map((allowed) =>
    allowed.toLowerCase(),
  );
  if (!allowedSelectors.includes(selector)) {
    return {
      ...base,
      passed: false,
      reason: `Selector ${selector} is not allowed for contract ${ctx.request.to}`,
    };
  }

  const constraint = selectorConstraint(contract.constraints, selector);
  if (constraint) {
    const constraintResult = evaluateEvmSelectorConstraint(
      rule,
      ctx,
      selector,
      data,
      constraint,
    );
    if (!constraintResult.passed) return constraintResult;
  }

  return { ...base, passed: true };
}

type ContractSelectorConstraint = NonNullable<
  ContractAllowlistConfig["contracts"][number]["constraints"]
>[string];

function selectorConstraint(
  constraints:
    | ContractAllowlistConfig["contracts"][number]["constraints"]
    | undefined,
  selector: string,
): ContractSelectorConstraint | undefined {
  if (!constraints) return undefined;
  const normalizedSelector = selector.toLowerCase();
  if (Object.hasOwn(constraints, normalizedSelector))
    return constraints[normalizedSelector];
  return Object.entries(constraints).find(
    ([key]) => key.toLowerCase() === normalizedSelector,
  )?.[1];
}

function decodeAbiAddress(word: string): string | null {
  if (!/^[a-fA-F0-9]{64}$/.test(word)) return null;
  const prefix = word.slice(0, 24);
  if (!/^0{24}$/.test(prefix)) return null;
  return `0x${word.slice(24)}`.toLowerCase();
}

function decodeAbiUint256(word: string): bigint | null {
  if (!/^[a-fA-F0-9]{64}$/.test(word)) return null;
  return BigInt(`0x${word}`);
}

function calldataWord(data: string, index: number): string | null {
  const body = data.slice(10);
  const start = index * 64;
  const end = start + 64;
  if (body.length < end) return null;
  return body.slice(start, end);
}

function normalizeAddressList(values: string[] | undefined): string[] {
  return (values ?? []).map((value) => value.toLowerCase());
}

function checkAddressConstraint(
  base: { policyId: string; type: PolicyRule["type"] },
  label: string,
  address: string | null,
  allowlist: string[] | undefined,
  blocklist: string[] | undefined,
): PolicyResult | null {
  if (!address) {
    return {
      ...base,
      passed: false,
      reason: `Unable to decode ${label} from calldata`,
    };
  }
  const allowed = normalizeAddressList(allowlist);
  if (allowed.length > 0 && !allowed.includes(address)) {
    return {
      ...base,
      passed: false,
      reason: `${label} ${address} is not in the selector allowlist`,
    };
  }
  const blocked = normalizeAddressList(blocklist);
  if (blocked.includes(address)) {
    return {
      ...base,
      passed: false,
      reason: `${label} ${address} is in the selector blocklist`,
    };
  }
  return null;
}

function checkAmountConstraint(
  base: { policyId: string; type: PolicyRule["type"] },
  amount: bigint | null,
  maxAmount: string | undefined,
): PolicyResult | null {
  if (maxAmount === undefined) return null;
  if (amount === null) {
    return {
      ...base,
      passed: false,
      reason: "Unable to decode amount from calldata",
    };
  }
  const max = parseUint256Decimal(maxAmount);
  if (max === null) {
    return {
      ...base,
      passed: false,
      reason: "Selector maxAmount must be a uint256 decimal string",
    };
  }
  if (amount > max) {
    return {
      ...base,
      passed: false,
      reason: `Token amount ${amount} exceeds selector maxAmount ${maxAmount}`,
    };
  }
  return null;
}

function checkTokenIdConstraint(
  base: { policyId: string; type: PolicyRule["type"] },
  tokenId: bigint | null,
  allowlist: string[] | undefined,
  blocklist: string[] | undefined,
): PolicyResult | null {
  const hasAllow = (allowlist?.length ?? 0) > 0;
  const hasBlock = (blocklist?.length ?? 0) > 0;
  if (!hasAllow && !hasBlock) return null;
  if (tokenId === null) {
    return {
      ...base,
      passed: false,
      reason: "Unable to decode tokenId from calldata",
    };
  }
  const id = tokenId.toString();
  if (hasAllow) {
    const allowed = (allowlist ?? []).map((value) => value.trim());
    if (!allowed.includes(id)) {
      return {
        ...base,
        passed: false,
        reason: `Token id ${id} is not in the selector tokenId allowlist`,
      };
    }
  }
  if (hasBlock) {
    const blocked = (blocklist ?? []).map((value) => value.trim());
    if (blocked.includes(id)) {
      return {
        ...base,
        passed: false,
        reason: `Token id ${id} is in the selector tokenId blocklist`,
      };
    }
  }
  return null;
}

/**
 * Decode a dynamic `uint256[]` ABI argument whose offset word sits at
 * `headWordIndex` (relative to the start of the argument data, after the
 * 4-byte selector). Returns null on any malformed/out-of-range encoding so
 * callers can fail closed. Length is bounded to avoid pathological inputs.
 */
function decodeAbiUint256Array(
  data: string,
  headWordIndex: number,
): bigint[] | null {
  const offsetWord = calldataWord(data, headWordIndex);
  if (!offsetWord) return null;
  const offset = decodeAbiUint256(offsetWord);
  if (offset === null || offset % 32n !== 0n) return null;
  const offsetWords = Number(offset / 32n);
  const lengthWord = calldataWord(data, offsetWords);
  if (!lengthWord) return null;
  const length = decodeAbiUint256(lengthWord);
  if (length === null || length > 1024n) return null;
  const count = Number(length);
  const out: bigint[] = [];
  for (let i = 0; i < count; i++) {
    const word = calldataWord(data, offsetWords + 1 + i);
    if (!word) return null;
    const value = decodeAbiUint256(word);
    if (value === null) return null;
    out.push(value);
  }
  return out;
}

function evaluateEvmSelectorConstraint(
  rule: PolicyRule,
  ctx: EvaluatorContext,
  selector: string,
  data: string,
  constraint: ContractSelectorConstraint,
): PolicyResult {
  const base = { policyId: rule.id, type: rule.type } as const;

  if (constraint.maxNativeValueWei !== undefined) {
    const requestValue = parseUint256Decimal(ctx.request.value);
    const maxValue = parseUint256Decimal(constraint.maxNativeValueWei);
    if (requestValue === null || maxValue === null) {
      return {
        ...base,
        passed: false,
        reason:
          "Native value and selector maxNativeValueWei must be uint256 decimal strings",
      };
    }
    if (requestValue > maxValue) {
      return {
        ...base,
        passed: false,
        reason: `Native value ${ctx.request.value} exceeds selector maxNativeValueWei ${constraint.maxNativeValueWei}`,
      };
    }
  }

  switch (selector) {
    case "0xa9059cbb": {
      const recipient = decodeAbiAddress(calldataWord(data, 0) ?? "");
      const amount = decodeAbiUint256(calldataWord(data, 1) ?? "");
      return (
        checkAddressConstraint(
          base,
          "recipient",
          recipient,
          constraint.recipientAllowlist,
          constraint.recipientBlocklist,
        ) ??
        checkAmountConstraint(base, amount, constraint.maxAmount) ?? {
          ...base,
          passed: true,
        }
      );
    }
    case "0x095ea7b3": {
      const spender = decodeAbiAddress(calldataWord(data, 0) ?? "");
      const amount = decodeAbiUint256(calldataWord(data, 1) ?? "");
      return (
        checkAddressConstraint(
          base,
          "spender",
          spender,
          constraint.spenderAllowlist,
          constraint.spenderBlocklist,
        ) ??
        checkAmountConstraint(base, amount, constraint.maxAmount) ?? {
          ...base,
          passed: true,
        }
      );
    }
    case "0x23b872dd": {
      const from = decodeAbiAddress(calldataWord(data, 0) ?? "");
      const recipient = decodeAbiAddress(calldataWord(data, 1) ?? "");
      const amount = decodeAbiUint256(calldataWord(data, 2) ?? "");
      return (
        checkAddressConstraint(
          base,
          "from",
          from,
          constraint.fromAllowlist,
          constraint.fromBlocklist,
        ) ??
        checkAddressConstraint(
          base,
          "recipient",
          recipient,
          constraint.recipientAllowlist,
          constraint.recipientBlocklist,
        ) ??
        checkAmountConstraint(base, amount, constraint.maxAmount) ?? {
          ...base,
          passed: true,
        }
      );
    }
    // ERC721 safeTransferFrom(address from, address to, uint256 tokenId)
    case "0x42842e0e":
    // ERC721 safeTransferFrom(address from, address to, uint256 tokenId, bytes data)
    case "0xb88d4fde": {
      const from = decodeAbiAddress(calldataWord(data, 0) ?? "");
      const recipient = decodeAbiAddress(calldataWord(data, 1) ?? "");
      const tokenId = decodeAbiUint256(calldataWord(data, 2) ?? "");
      return (
        checkAddressConstraint(
          base,
          "from",
          from,
          constraint.fromAllowlist,
          constraint.fromBlocklist,
        ) ??
        checkAddressConstraint(
          base,
          "recipient",
          recipient,
          constraint.recipientAllowlist,
          constraint.recipientBlocklist,
        ) ??
        checkTokenIdConstraint(
          base,
          tokenId,
          constraint.tokenIdAllowlist,
          constraint.tokenIdBlocklist,
        ) ?? { ...base, passed: true }
      );
    }
    // ERC721/ERC1155 setApprovalForAll(address operator, bool approved)
    case "0xa22cb465": {
      const operator = decodeAbiAddress(calldataWord(data, 0) ?? "");
      const approved = decodeAbiUint256(calldataWord(data, 1) ?? "");
      // Revoking approval (approved == 0) is always safe — allow it regardless
      // of the operator allowlist so agents can always pull back access.
      if (approved !== null && approved === 0n) {
        return { ...base, passed: true };
      }
      // Granting blanket approval: treat the operator as a spender.
      return (
        checkAddressConstraint(
          base,
          "operator",
          operator,
          constraint.spenderAllowlist,
          constraint.spenderBlocklist,
        ) ?? { ...base, passed: true }
      );
    }
    // ERC1155 safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data)
    case "0xf242432a": {
      const from = decodeAbiAddress(calldataWord(data, 0) ?? "");
      const recipient = decodeAbiAddress(calldataWord(data, 1) ?? "");
      const tokenId = decodeAbiUint256(calldataWord(data, 2) ?? "");
      const amount = decodeAbiUint256(calldataWord(data, 3) ?? "");
      return (
        checkAddressConstraint(
          base,
          "from",
          from,
          constraint.fromAllowlist,
          constraint.fromBlocklist,
        ) ??
        checkAddressConstraint(
          base,
          "recipient",
          recipient,
          constraint.recipientAllowlist,
          constraint.recipientBlocklist,
        ) ??
        checkTokenIdConstraint(
          base,
          tokenId,
          constraint.tokenIdAllowlist,
          constraint.tokenIdBlocklist,
        ) ??
        checkAmountConstraint(base, amount, constraint.maxAmount) ?? {
          ...base,
          passed: true,
        }
      );
    }
    // ERC1155 safeBatchTransferFrom(address from, address to, uint256[] ids, uint256[] amounts, bytes data)
    case "0x2eb2c2d6": {
      const from = decodeAbiAddress(calldataWord(data, 0) ?? "");
      const recipient = decodeAbiAddress(calldataWord(data, 1) ?? "");
      const addressCheck =
        checkAddressConstraint(
          base,
          "from",
          from,
          constraint.fromAllowlist,
          constraint.fromBlocklist,
        ) ??
        checkAddressConstraint(
          base,
          "recipient",
          recipient,
          constraint.recipientAllowlist,
          constraint.recipientBlocklist,
        );
      if (addressCheck) return addressCheck;

      const needTokenIds =
        (constraint.tokenIdAllowlist?.length ?? 0) > 0 ||
        (constraint.tokenIdBlocklist?.length ?? 0) > 0;
      if (needTokenIds) {
        const ids = decodeAbiUint256Array(data, 2);
        if (ids === null) {
          return {
            ...base,
            passed: false,
            reason: "Unable to decode tokenId array from batch calldata",
          };
        }
        for (const id of ids) {
          const result = checkTokenIdConstraint(
            base,
            id,
            constraint.tokenIdAllowlist,
            constraint.tokenIdBlocklist,
          );
          if (result) return result;
        }
      }

      if (constraint.maxAmount !== undefined) {
        const amounts = decodeAbiUint256Array(data, 3);
        if (amounts === null) {
          return {
            ...base,
            passed: false,
            reason: "Unable to decode amount array from batch calldata",
          };
        }
        for (const amount of amounts) {
          const result = checkAmountConstraint(
            base,
            amount,
            constraint.maxAmount,
          );
          if (result) return result;
        }
      }

      return { ...base, passed: true };
    }
    default: {
      // `maxNativeValueWei` is selector-agnostic and was already enforced
      // above. Any OTHER declared constraint requires decoding calldata for a
      // selector this engine does not know — fail closed rather than let the
      // operator believe a recipient/amount/tokenId gate is enforced when it
      // is a silent no-op (SEC-038). Empty arrays are no-ops, matching the
      // known-selector arms.
      const hasUnenforceableConstraint = Object.entries(constraint).some(
        ([key, value]) => {
          if (key === "maxNativeValueWei" || value === undefined) return false;
          return !(Array.isArray(value) && value.length === 0);
        },
      );
      if (hasUnenforceableConstraint) {
        return {
          ...base,
          passed: false,
          reason: `Selector constraints cannot be enforced for unrecognized selector ${selector}`,
        };
      }
      return { ...base, passed: true };
    }
  }
}

// ─── EIP-712 typed-data condition ───────────────────────────────────────────

const MAX_UINT256_BIGINT = BigInt(MAX_UINT256_DECIMAL);

/** Normalize a plain EVM address string, or null if it is not one. */
function normalizeEvmAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(trimmed) ? trimmed : null;
}

/**
 * Parse an EIP-712 uint field. Accepts a non-negative JS number/bigint, a
 * decimal string, or a `0x`-hex string. Returns null (→ fail closed) for
 * anything else or any value exceeding uint256.
 */
function parseTypedDataUint(raw: unknown): bigint | null {
  let parsed: bigint | null = null;
  if (typeof raw === "bigint") {
    parsed = raw;
  } else if (typeof raw === "number") {
    if (!Number.isInteger(raw) || raw < 0) return null;
    parsed = BigInt(raw);
  } else if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (/^0x[0-9a-fA-F]+$/.test(trimmed)) {
      parsed = BigInt(trimmed);
    } else {
      parsed = parseUint256Decimal(trimmed);
    }
  }
  if (parsed === null || parsed < 0n || parsed > MAX_UINT256_BIGINT)
    return null;
  return parsed;
}

/** Walk a dot-path (e.g. `"details.token"`) into the decoded message object. */
function getTypedDataField(
  value: Record<string, unknown>,
  path: string,
): unknown {
  const parts = path.split(".");
  let current: unknown = value;
  for (const part of parts) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function evaluateTypedDataMessageCondition(
  base: { policyId: string; type: PolicyRule["type"] },
  condition: TypedDataMessageCondition,
  message: Record<string, unknown>,
): PolicyResult | null {
  const raw = getTypedDataField(message, condition.field);
  const fail = (reason: string): PolicyResult => ({
    ...base,
    passed: false,
    reason,
  });

  switch (condition.operator) {
    case "address_in":
    case "address_not_in": {
      const addr = normalizeEvmAddress(raw);
      if (!addr)
        return fail(
          `Typed-data field ${condition.field} is not a valid address`,
        );
      const list = (condition.values ?? []).map((value) => value.toLowerCase());
      const present = list.includes(addr);
      if (condition.operator === "address_in" && !present) {
        return fail(
          `Typed-data field ${condition.field} (${addr}) is not in the allowed list`,
        );
      }
      if (condition.operator === "address_not_in" && present) {
        return fail(
          `Typed-data field ${condition.field} (${addr}) is in the blocked list`,
        );
      }
      return null;
    }
    case "eq": {
      if (raw === undefined || raw === null) {
        return fail(`Typed-data field ${condition.field} is missing`);
      }
      if (String(raw) !== String(condition.value ?? "")) {
        return fail(
          `Typed-data field ${condition.field} must equal ${String(condition.value)}`,
        );
      }
      return null;
    }
    case "in":
    case "not_in": {
      if (raw === undefined || raw === null) {
        return fail(`Typed-data field ${condition.field} is missing`);
      }
      const target = String(raw);
      const present = (condition.values ?? []).includes(target);
      if (condition.operator === "in" && !present) {
        return fail(
          `Typed-data field ${condition.field} (${target}) is not in the allowed list`,
        );
      }
      if (condition.operator === "not_in" && present) {
        return fail(
          `Typed-data field ${condition.field} (${target}) is in the blocked list`,
        );
      }
      return null;
    }
    case "uint_max": {
      const max = parseTypedDataUint(condition.value);
      if (max === null) {
        return fail(
          `Typed-data condition for ${condition.field} has an invalid uint_max bound`,
        );
      }
      const amount = parseTypedDataUint(raw);
      if (amount === null) {
        return fail(
          `Typed-data field ${condition.field} is not a uint256 value`,
        );
      }
      if (amount > max) {
        return fail(
          `Typed-data field ${condition.field} (${amount}) exceeds max ${String(condition.value)}`,
        );
      }
      return null;
    }
    default:
      return fail(
        `Unsupported typed-data message operator: ${String(
          (condition as { operator?: unknown }).operator,
        )}`,
      );
  }
}

/**
 * Evaluate a Privy-style EIP-712 `typed-data` condition. Fails closed: any
 * constraint that is configured must hold, or the signature is denied. When
 * the request is not a typed-data sign (no `ctx.typedData`) the policy is not
 * applicable and passes.
 */
function evaluateTypedData(
  rule: PolicyRule,
  ctx: EvaluatorContext,
): PolicyResult {
  const config = rule.config as unknown as TypedDataConditionConfig;
  const base = { policyId: rule.id, type: rule.type } as const;

  if (!ctx.typedData) {
    return {
      ...base,
      passed: true,
      reason: "Not a typed-data signing request",
    };
  }

  const { domain, primaryType, value } = ctx.typedData;
  const verifyingContract = normalizeEvmAddress(domain.verifyingContract);

  if ((config.verifyingContractAllowlist?.length ?? 0) > 0) {
    const allowed = (config.verifyingContractAllowlist ?? []).map((a) =>
      a.toLowerCase(),
    );
    if (!verifyingContract || !allowed.includes(verifyingContract)) {
      return {
        ...base,
        passed: false,
        reason: `Typed-data domain verifyingContract ${String(
          domain.verifyingContract,
        )} is not in the allowlist`,
      };
    }
  }

  if ((config.verifyingContractBlocklist?.length ?? 0) > 0) {
    const blocked = (config.verifyingContractBlocklist ?? []).map((a) =>
      a.toLowerCase(),
    );
    if (verifyingContract && blocked.includes(verifyingContract)) {
      return {
        ...base,
        passed: false,
        reason: `Typed-data domain verifyingContract ${String(
          domain.verifyingContract,
        )} is in the blocklist`,
      };
    }
  }

  if ((config.allowedChainIds?.length ?? 0) > 0) {
    if (
      typeof domain.chainId !== "number" ||
      !(config.allowedChainIds ?? []).includes(domain.chainId)
    ) {
      return {
        ...base,
        passed: false,
        reason: `Typed-data domain chainId ${String(domain.chainId)} is not in the allowed list`,
      };
    }
  }

  if ((config.allowedDomainNames?.length ?? 0) > 0) {
    if (
      typeof domain.name !== "string" ||
      !(config.allowedDomainNames ?? []).includes(domain.name)
    ) {
      return {
        ...base,
        passed: false,
        reason: `Typed-data domain name ${String(domain.name)} is not in the allowed list`,
      };
    }
  }

  if ((config.allowedPrimaryTypes?.length ?? 0) > 0) {
    if (!(config.allowedPrimaryTypes ?? []).includes(primaryType)) {
      return {
        ...base,
        passed: false,
        reason: `Typed-data primaryType ${primaryType} is not in the allowed list`,
      };
    }
  }

  for (const condition of config.messageConditions ?? []) {
    const result = evaluateTypedDataMessageCondition(base, condition, value);
    if (result) return result;
  }

  return { ...base, passed: true };
}
