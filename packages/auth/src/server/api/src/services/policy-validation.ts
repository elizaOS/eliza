import { Address, NETWORK, TEST_NETWORK } from "@scure/btc-signer";
import { isPersistedPolicyType } from "../../../db/src/index.ts";
import type { PolicyRule } from "../../../shared/src/index.ts";
import {
  decodeMoneroAddress,
  isValidSolanaPublicKey,
} from "../../../vault/src/index.ts";

const CONDITION_FIELDS = new Set([
  "to",
  "ethereum_transaction.to",
  "ethereum_transaction.chain_id",
  "ethereum_transaction.value",
  "ethereum_transaction.data",
  "solana_system_program_instruction.Transfer.to",
  "chain_id",
  "value",
  "data",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const MAX_UINT256_DECIMAL =
  "115792089237316195423570985008687907853269984665640564039457584007913129639935";
const MAX_UINT256_DECIMAL_DIGITS = 78;

function isWeiString(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return false;
  const normalized = value.replace(/^0+/, "") || "0";
  if (normalized.length > MAX_UINT256_DECIMAL_DIGITS) return false;
  return (
    normalized.length < MAX_UINT256_DECIMAL_DIGITS ||
    normalized <= MAX_UINT256_DECIMAL
  );
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isEvmAddress(value: unknown): value is string {
  return typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value);
}

function isBitcoinAddress(value: unknown): value is string {
  if (typeof value !== "string") return false;
  for (const network of [NETWORK, TEST_NETWORK]) {
    try {
      Address(network).decode(value);
      return true;
    } catch {
      // Try the other supported network.
    }
  }
  return false;
}

function isMoneroAddress(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    decodeMoneroAddress(value);
    return true;
  } catch {
    return false;
  }
}

function isSupportedPolicyAddress(value: unknown): value is string {
  return (
    isEvmAddress(value) ||
    isValidSolanaPublicKey(value) ||
    isBitcoinAddress(value) ||
    isMoneroAddress(value)
  );
}

function isEvmSelector(value: unknown): value is string {
  return typeof value === "string" && /^0x[a-fA-F0-9]{8}$/.test(value);
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

function areOptionalEvmAddresses(value: unknown): boolean {
  return (
    value === undefined || (Array.isArray(value) && value.every(isEvmAddress))
  );
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isNonEmptyArrayOf(
  value: unknown,
  predicate: (entry: unknown) => boolean,
): boolean {
  return Array.isArray(value) && value.length > 0 && value.every(predicate);
}

const TYPED_DATA_CONFIG_KEYS = new Set([
  "verifyingContractAllowlist",
  "verifyingContractBlocklist",
  "allowedChainIds",
  "allowedDomainNames",
  "allowedPrimaryTypes",
  "messageConditions",
]);
const TYPED_DATA_CONDITION_BASE_KEYS = new Set(["field", "operator"]);
const TYPED_DATA_CONDITION_VALUE_KEYS = new Set(["field", "operator", "value"]);
const TYPED_DATA_CONDITION_VALUES_KEYS = new Set([
  "field",
  "operator",
  "values",
]);
const FORBIDDEN_TYPED_DATA_PATH_SEGMENTS = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);

function isTypedDataFieldPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  const segments = value.split(".");
  return segments.every(
    (segment) =>
      /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment) &&
      !FORBIDDEN_TYPED_DATA_PATH_SEGMENTS.has(segment),
  );
}

function isTypedDataUintBound(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  const hex = /^0x([0-9a-fA-F]+)$/.exec(trimmed);
  if (hex) {
    const normalized = hex[1]?.replace(/^0+/, "") || "0";
    return normalized.length <= 64;
  }
  return isWeiString(trimmed);
}

function validatePolicyConfig(policy: PolicyRule): string | null {
  const config = policy.config;

  switch (policy.type) {
    case "spending-limit": {
      const weiFields = ["maxPerTx", "maxPerDay", "maxPerWeek"] as const;
      const usdFields = [
        "maxPerTxUsd",
        "maxPerDayUsd",
        "maxPerWeekUsd",
      ] as const;
      for (const field of weiFields) {
        if (
          Object.hasOwn(config, field) &&
          config[field] !== undefined &&
          !isWeiString(config[field])
        ) {
          return `spending-limit.${field} must be a wei string`;
        }
      }
      for (const field of usdFields) {
        if (
          Object.hasOwn(config, field) &&
          config[field] !== undefined &&
          !isNonNegativeFiniteNumber(config[field])
        ) {
          return `spending-limit.${field} must be a non-negative finite number`;
        }
      }
      if (
        Object.hasOwn(config, "maxAmount") &&
        !isWeiString(config.maxAmount)
      ) {
        return "spending-limit.maxAmount must be a wei string";
      }
      const legacyPeriods = new Set([
        "tx",
        "transaction",
        "day",
        "daily",
        "week",
        "weekly",
      ]);
      if (
        Object.hasOwn(config, "period") &&
        (typeof config.period !== "string" || !legacyPeriods.has(config.period))
      ) {
        return "spending-limit.period must be tx, transaction, day, daily, week, or weekly";
      }
      if (Object.hasOwn(config, "period") && !isWeiString(config.maxAmount)) {
        return "spending-limit.period requires maxAmount";
      }
      const hasWeiLimit = weiFields.some(
        (field) => Object.hasOwn(config, field) && isWeiString(config[field]),
      );
      const hasUsdLimit = usdFields.some(
        (field) =>
          Object.hasOwn(config, field) &&
          isNonNegativeFiniteNumber(config[field]),
      );
      const hasLegacyLimit =
        Object.hasOwn(config, "maxAmount") && isWeiString(config.maxAmount);
      if (!hasWeiLimit && !hasUsdLimit && !hasLegacyLimit) {
        return "spending-limit requires at least one wei or USD limit";
      }
      return null;
    }

    case "approved-addresses":
      if (
        !Array.isArray(config.addresses) ||
        !config.addresses.every(isSupportedPolicyAddress)
      ) {
        return "approved-addresses.addresses must contain valid EVM, Solana, Bitcoin, or Monero addresses";
      }
      if (config.mode !== "whitelist" && config.mode !== "blacklist") {
        return "approved-addresses.mode must be whitelist or blacklist";
      }
      return null;

    case "auto-approve-threshold":
      if (
        !isWeiString(config.threshold) &&
        !isPositiveFiniteNumber(config.thresholdUsd)
      ) {
        return "auto-approve-threshold requires threshold or thresholdUsd";
      }
      if (config.threshold !== undefined && !isWeiString(config.threshold)) {
        return "auto-approve-threshold.threshold must be a wei string";
      }
      if (
        config.thresholdUsd !== undefined &&
        !isPositiveFiniteNumber(config.thresholdUsd)
      ) {
        return "auto-approve-threshold.thresholdUsd must be a positive number";
      }
      return null;

    case "time-window":
      if (
        !Array.isArray(config.allowedHours) ||
        !config.allowedHours.every(
          (window) =>
            isPlainObject(window) &&
            Number.isInteger(window.start) &&
            Number.isInteger(window.end) &&
            Number(window.start) >= 0 &&
            Number(window.start) <= 23 &&
            Number(window.end) >= 0 &&
            // End is exclusive, so 24 is the only way to represent a window
            // that includes the 23:00-23:59 UTC hour.
            Number(window.end) <= 24,
        )
      ) {
        return "time-window.allowedHours must contain UTC hour windows";
      }
      if (
        !Array.isArray(config.allowedDays) ||
        !config.allowedDays.every(
          (day) => Number.isInteger(day) && day >= 0 && day <= 6,
        )
      ) {
        return "time-window.allowedDays must contain weekdays 0-6";
      }
      // An enabled rule with no windows at all is a fail-open no-op in the
      // engine (SEC-180); reject it at write time.
      if (config.allowedHours.length === 0 && config.allowedDays.length === 0) {
        return "time-window requires at least one allowed hour window or allowed day";
      }
      return null;

    case "rate-limit":
      if (
        !isPositiveInteger(config.maxTxPerHour) ||
        !isPositiveInteger(config.maxTxPerDay)
      ) {
        return "rate-limit requires positive integer maxTxPerHour and maxTxPerDay";
      }
      return null;

    case "allowed-chains":
      if (
        !Array.isArray(config.chains) ||
        config.chains.length === 0 ||
        !config.chains.every(
          (chain) => typeof chain === "string" && chain.trim().length > 0,
        )
      ) {
        return "allowed-chains.chains must be a non-empty string array";
      }
      return null;

    case "condition-set":
      if (
        typeof config.conditionSetId !== "string" ||
        config.conditionSetId.trim() === ""
      ) {
        return "condition-set.conditionSetId is required";
      }
      if (!isUuid(config.conditionSetId)) {
        return "condition-set.conditionSetId must be a UUID";
      }
      if (
        config.field !== undefined &&
        !CONDITION_FIELDS.has(String(config.field))
      ) {
        return "condition-set.field is invalid";
      }
      if (
        config.operator !== undefined &&
        config.operator !== "in_condition_set" &&
        config.operator !== "not_in_condition_set"
      ) {
        return "condition-set.operator is invalid";
      }
      if (
        config.caseSensitive !== undefined &&
        typeof config.caseSensitive !== "boolean"
      ) {
        return "condition-set.caseSensitive must be a boolean";
      }
      return null;

    case "contract-allowlist":
      if (
        !Array.isArray(config.contracts) ||
        config.contracts.length === 0 ||
        !config.contracts.every((contract) => {
          if (
            !isPlainObject(contract) ||
            !isEvmAddress(contract.address) ||
            !Array.isArray(contract.selectors) ||
            contract.selectors.length === 0 ||
            !contract.selectors.every(isEvmSelector)
          ) {
            return false;
          }
          if (contract.constraints === undefined) return true;
          if (!isPlainObject(contract.constraints)) return false;
          const selectors = new Set(
            contract.selectors.map((selector) => selector.toLowerCase()),
          );
          return Object.entries(contract.constraints).every(
            ([selector, constraint]) => {
              if (
                !isEvmSelector(selector) ||
                !selectors.has(selector.toLowerCase())
              )
                return false;
              if (!isPlainObject(constraint)) return false;
              return (
                areOptionalEvmAddresses(constraint.recipientAllowlist) &&
                areOptionalEvmAddresses(constraint.recipientBlocklist) &&
                areOptionalEvmAddresses(constraint.spenderAllowlist) &&
                areOptionalEvmAddresses(constraint.spenderBlocklist) &&
                areOptionalEvmAddresses(constraint.fromAllowlist) &&
                areOptionalEvmAddresses(constraint.fromBlocklist) &&
                (constraint.maxNativeValueWei === undefined ||
                  isWeiString(constraint.maxNativeValueWei)) &&
                (constraint.maxAmount === undefined ||
                  isWeiString(constraint.maxAmount))
              );
            },
          );
        })
      ) {
        return "contract-allowlist.contracts must be non-empty entries with EVM address, 4-byte selectors, and valid selector constraints";
      }
      return null;

    case "reputation-threshold":
      if (
        typeof config.minScore !== "number" ||
        !Number.isFinite(config.minScore) ||
        config.minScore < 0 ||
        config.minScore > 100
      ) {
        return "reputation-threshold.minScore must be a number from 0-100";
      }
      if (
        !["approve", "require-approval", "block"].includes(
          String(config.action),
        )
      ) {
        return "reputation-threshold.action is invalid";
      }
      if (
        !["internal", "onchain", "combined"].includes(String(config.source))
      ) {
        return "reputation-threshold.source is invalid";
      }
      if (
        !["approve", "require-approval", "block"].includes(
          String(config.fallbackAction),
        )
      ) {
        return "reputation-threshold.fallbackAction is invalid";
      }
      return null;

    case "reputation-scaling":
      if (
        !isWeiString(config.baseMaxPerTx) ||
        !isWeiString(config.maxMaxPerTx)
      ) {
        return "reputation-scaling requires baseMaxPerTx and maxMaxPerTx wei strings";
      }
      if (BigInt(config.maxMaxPerTx) < BigInt(config.baseMaxPerTx)) {
        return "reputation-scaling.maxMaxPerTx must be greater than or equal to baseMaxPerTx";
      }
      if (config.curve !== "linear" && config.curve !== "logarithmic") {
        return "reputation-scaling.curve must be linear or logarithmic";
      }
      return null;

    case "venue-allowlist":
      if (
        !Array.isArray(config.allowedVenues) ||
        config.allowedVenues.length === 0 ||
        !config.allowedVenues.every(
          (venue) => typeof venue === "string" && venue.trim(),
        )
      ) {
        return "venue-allowlist.allowedVenues must be a non-empty string array";
      }
      return null;

    case "leverage-cap":
      if (!isPositiveFiniteNumber(config.maxLeverage)) {
        return "leverage-cap.maxLeverage must be a positive number";
      }
      return null;

    case "typed-data": {
      if (!hasOnlyKeys(config, TYPED_DATA_CONFIG_KEYS)) {
        return "typed-data.config contains an unknown key";
      }
      if (
        config.verifyingContractAllowlist !== undefined &&
        !isNonEmptyArrayOf(config.verifyingContractAllowlist, isEvmAddress)
      ) {
        return "typed-data.verifyingContractAllowlist must be a non-empty EVM address array";
      }
      if (
        config.verifyingContractBlocklist !== undefined &&
        !isNonEmptyArrayOf(config.verifyingContractBlocklist, isEvmAddress)
      ) {
        return "typed-data.verifyingContractBlocklist must be a non-empty EVM address array";
      }
      if (
        config.allowedChainIds !== undefined &&
        !isNonEmptyArrayOf(config.allowedChainIds, isPositiveInteger)
      ) {
        return "typed-data.allowedChainIds must be a non-empty positive safe-integer array";
      }
      if (
        config.allowedDomainNames !== undefined &&
        !isNonEmptyArrayOf(
          config.allowedDomainNames,
          (name) =>
            typeof name === "string" && name.length > 0 && name === name.trim(),
        )
      ) {
        return "typed-data.allowedDomainNames must be a non-empty array of trimmed strings";
      }
      if (
        config.allowedPrimaryTypes !== undefined &&
        !isNonEmptyArrayOf(
          config.allowedPrimaryTypes,
          (type) =>
            typeof type === "string" && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(type),
        )
      ) {
        return "typed-data.allowedPrimaryTypes must be a non-empty EIP-712 type-name array";
      }
      if (config.messageConditions !== undefined) {
        if (
          !Array.isArray(config.messageConditions) ||
          config.messageConditions.length === 0 ||
          config.messageConditions.some((condition) => {
            if (
              !isPlainObject(condition) ||
              !isTypedDataFieldPath(condition.field) ||
              typeof condition.operator !== "string" ||
              !hasOnlyKeys(
                condition,
                condition.operator === "address_in" ||
                  condition.operator === "address_not_in" ||
                  condition.operator === "in" ||
                  condition.operator === "not_in"
                  ? TYPED_DATA_CONDITION_VALUES_KEYS
                  : condition.operator === "eq" ||
                      condition.operator === "uint_max"
                    ? TYPED_DATA_CONDITION_VALUE_KEYS
                    : TYPED_DATA_CONDITION_BASE_KEYS,
              )
            ) {
              return true;
            }
            if (
              condition.operator === "address_in" ||
              condition.operator === "address_not_in"
            ) {
              return !isNonEmptyArrayOf(condition.values, isEvmAddress);
            }
            if (
              condition.operator === "in" ||
              condition.operator === "not_in"
            ) {
              return !isNonEmptyArrayOf(
                condition.values,
                (value) => typeof value === "string",
              );
            }
            if (condition.operator === "eq") {
              return typeof condition.value !== "string";
            }
            if (condition.operator === "uint_max") {
              return !isTypedDataUintBound(condition.value);
            }
            return true;
          })
        ) {
          return "typed-data.messageConditions must be a non-empty array of valid conditions with exactly the matching value/values shape";
        }
      }
      return null;
    }

    case "raw-signing-chain":
      if (
        config.allowedChains !== undefined &&
        (!Array.isArray(config.allowedChains) ||
          config.allowedChains.some(
            (chain) => typeof chain !== "string" || !chain.trim(),
          ))
      ) {
        return "raw-signing-chain.allowedChains must be a string array";
      }
      if (
        config.blockedChains !== undefined &&
        (!Array.isArray(config.blockedChains) ||
          config.blockedChains.some(
            (chain) => typeof chain !== "string" || !chain.trim(),
          ))
      ) {
        return "raw-signing-chain.blockedChains must be a string array";
      }
      if (
        config.allowedCurves !== undefined &&
        (!Array.isArray(config.allowedCurves) ||
          config.allowedCurves.some(
            (curve) => typeof curve !== "string" || !curve.trim(),
          ))
      ) {
        return "raw-signing-chain.allowedCurves must be a string array";
      }
      if (
        config.requireSupported !== undefined &&
        typeof config.requireSupported !== "boolean"
      ) {
        return "raw-signing-chain.requireSupported must be a boolean";
      }
      return null;

    default:
      return `Unknown policy type "${policy.type}"`;
  }
}

export function validatePolicyRule(policy: unknown): policy is PolicyRule {
  return getPolicyRuleValidationError(policy) === null;
}

const MAX_POLICY_RULES = 50;
const MAX_POLICY_RULES_BYTES = 65_536;

export function getPolicyRuleValidationError(policy: unknown): string | null {
  if (!isPlainObject(policy)) return "Each policy must be an object";
  if (typeof policy.type !== "string" || policy.type.trim() === "") {
    return "Each policy must have a non-empty 'type' field";
  }
  if (!isPersistedPolicyType(policy.type)) {
    return `Unknown policy type "${policy.type}"`;
  }
  if (typeof policy.enabled !== "boolean") {
    return `Policy "${String(policy.id || policy.type)}": enabled must be a boolean`;
  }
  if (!isPlainObject(policy.config)) {
    return `Policy "${String(policy.id || policy.type)}": config must be an object`;
  }
  return validatePolicyConfig(policy as unknown as PolicyRule);
}

export function getPolicyRulesValidationError(
  policies: unknown[],
): string | null {
  if (policies.length > MAX_POLICY_RULES) {
    return `Policy list cannot contain more than ${MAX_POLICY_RULES} rules`;
  }
  if (JSON.stringify(policies).length > MAX_POLICY_RULES_BYTES) {
    return `Policy list cannot exceed ${MAX_POLICY_RULES_BYTES} bytes`;
  }

  const ids = new Set<string>();
  const singletonTypes = new Set<string>();
  for (const policy of policies) {
    const error = getPolicyRuleValidationError(policy);
    if (error) return error;
    if (
      isPlainObject(policy) &&
      typeof policy.id === "string" &&
      policy.id.trim()
    ) {
      if (ids.has(policy.id)) return `Duplicate policy id "${policy.id}"`;
      ids.add(policy.id);
    }
    if (
      isPlainObject(policy) &&
      policy.enabled !== false &&
      policy.type === "auto-approve-threshold"
    ) {
      if (singletonTypes.has(policy.type))
        return `Duplicate policy type "${policy.type}"`;
      singletonTypes.add(policy.type);
    }
  }
  return null;
}
