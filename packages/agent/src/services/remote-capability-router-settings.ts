/**
 * Single parser for the capability-router settings shared by the runtime
 * (router config, remote plugin trust policy) and the connect route that
 * persists them: ELIZA_CAPABILITY_ROUTER_URLS, _ALLOWED_MODULES and
 * _TRUST_POLICY. Every accepted format parses here; anything malformed throws
 * {@link CapabilityRouterSettingError} instead of being dropped, because a
 * dropped allowlist or trust requirement silently widens what remote plugins
 * may load.
 */
import { ElizaError, trimEndCharacters } from "@elizaos/core";
import type { RemoteCapabilityEndpointConfig } from "./remote-capability-router.ts";

export const CAPABILITY_ROUTER_URLS_SETTING = "ELIZA_CAPABILITY_ROUTER_URLS";
export const CAPABILITY_ROUTER_ALLOWED_MODULES_SETTING =
  "ELIZA_CAPABILITY_ROUTER_ALLOWED_MODULES";
export const CAPABILITY_ROUTER_TRUST_POLICY_SETTING =
  "ELIZA_CAPABILITY_ROUTER_TRUST_POLICY";

export type CapabilityRouterSettingKey =
  | typeof CAPABILITY_ROUTER_URLS_SETTING
  | typeof CAPABILITY_ROUTER_ALLOWED_MODULES_SETTING
  | typeof CAPABILITY_ROUTER_TRUST_POLICY_SETTING;

/** A capability-router setting is present but malformed. */
export class CapabilityRouterSettingError extends ElizaError {
  override readonly name = "CapabilityRouterSettingError";
  readonly key: CapabilityRouterSettingKey;
  readonly reason: string;

  constructor(
    key: CapabilityRouterSettingKey,
    reason: string,
    options?: { cause?: unknown },
  ) {
    super(`Invalid ${key}: ${reason}`, {
      code: "CAPABILITY_ROUTER_SETTING_INVALID",
      cause: options?.cause,
      context: { key, reason },
      severity: "fatal",
    });
    this.key = key;
    this.reason = reason;
  }
}

/**
 * The provenance trust options a trust-policy setting may carry, either at the
 * top level (global) or per endpoint id.
 */
export type CapabilityRouterTrustPolicySettingValue = {
  allowedProvenanceIssuers?: string[];
  trustedProvenancePublicKeys?: Record<string, string>;
  requireSignedProvenance?: boolean;
  requireVerifiedProvenance?: boolean;
  requireProvenanceDigestMatch?: boolean;
};

const TRUST_POLICY_FIELDS = [
  "allowedProvenanceIssuers",
  "trustedProvenancePublicKeys",
  "requireSignedProvenance",
  "requireVerifiedProvenance",
  "requireProvenanceDigestMatch",
] as const;
const TRUST_POLICY_FIELD_SET: ReadonlySet<string> = new Set(
  TRUST_POLICY_FIELDS,
);

/**
 * An endpoint id collides with a trust-policy option name. The trust-policy
 * setting stores global options and per-endpoint policies in one object, so
 * such an id would be read back as a global option and corrupt the setting.
 */
export class CapabilityRouterReservedEndpointIdError extends ElizaError {
  override readonly name = "CapabilityRouterReservedEndpointIdError";
  readonly endpointId: string;

  constructor(endpointId: string, field: string) {
    super(
      `${field} "${endpointId}" is reserved: it names a trust policy option (${TRUST_POLICY_FIELDS.join(", ")}). Choose a different endpoint id.`,
      {
        code: "CAPABILITY_ROUTER_ENDPOINT_ID_RESERVED",
        context: { endpointId, field },
      },
    );
    this.endpointId = endpointId;
  }
}

/** True when an endpoint id would collide with a trust-policy option key. */
export function isReservedCapabilityRouterEndpointId(id: string): boolean {
  return TRUST_POLICY_FIELD_SET.has(id.trim());
}

/**
 * Throws {@link CapabilityRouterReservedEndpointIdError} when `id` names a
 * trust-policy option; `field` labels the offending input in the message.
 */
export function assertCapabilityRouterEndpointIdAllowed(
  id: string,
  field: string,
): void {
  if (isReservedCapabilityRouterEndpointId(id)) {
    throw new CapabilityRouterReservedEndpointIdError(id.trim(), field);
  }
}

/**
 * ELIZA_CAPABILITY_ROUTER_ALLOWED_MODULES is either a global JSON array (the
 * allowlist for every endpoint) or an object keyed by endpoint id; never both.
 */
export type CapabilityRouterModuleAllowlistSetting =
  | { kind: "global"; moduleIds: string[] }
  | { kind: "endpoints"; endpoints: Record<string, string[]> };

/**
 * ELIZA_CAPABILITY_ROUTER_TRUST_POLICY is an object whose recognized trust
 * option keys apply globally and whose other keys are endpoint ids mapping to
 * per-endpoint policies.
 */
export type CapabilityRouterTrustPolicySetting = {
  global: CapabilityRouterTrustPolicySettingValue;
  endpoints: Record<string, CapabilityRouterTrustPolicySettingValue>;
};

/**
 * Parses ELIZA_CAPABILITY_ROUTER_URLS: a comma-separated URL list, or a JSON
 * array whose entries are URL strings or `{ id?, baseUrl, token? }` objects.
 * Entries without an id get `remote-<index+1>`. Tokens are returned only when
 * the entry carries one; callers apply any default token themselves.
 */
export function parseCapabilityRouterEndpointsSetting(
  value: string | undefined,
): RemoteCapabilityEndpointConfig[] {
  const raw = value?.trim();
  if (!raw) return [];
  if (raw.startsWith("{")) {
    throw new CapabilityRouterSettingError(
      CAPABILITY_ROUTER_URLS_SETTING,
      "expected a comma-separated URL list or a JSON array, not an object",
    );
  }
  if (!raw.startsWith("[")) {
    return raw
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((baseUrl, index) => ({
        id: `remote-${index + 1}`,
        baseUrl: stripTrailingSlashes(baseUrl),
      }));
  }
  const parsed = parseJson(CAPABILITY_ROUTER_URLS_SETTING, raw);
  if (!Array.isArray(parsed)) {
    throw new CapabilityRouterSettingError(
      CAPABILITY_ROUTER_URLS_SETTING,
      "expected a JSON array",
    );
  }
  return parsed.map((item, index): RemoteCapabilityEndpointConfig => {
    const fallbackId = `remote-${index + 1}`;
    if (typeof item === "string") {
      if (!item.trim()) {
        throw new CapabilityRouterSettingError(
          CAPABILITY_ROUTER_URLS_SETTING,
          `entry ${index} must be a non-empty URL`,
        );
      }
      return { id: fallbackId, baseUrl: stripTrailingSlashes(item.trim()) };
    }
    if (!isRecord(item)) {
      throw new CapabilityRouterSettingError(
        CAPABILITY_ROUTER_URLS_SETTING,
        `entry ${index} must be a URL string or an object`,
      );
    }
    if (typeof item.baseUrl !== "string" || !item.baseUrl.trim()) {
      throw new CapabilityRouterSettingError(
        CAPABILITY_ROUTER_URLS_SETTING,
        `entry ${index} is missing a baseUrl`,
      );
    }
    if (item.id !== undefined && typeof item.id !== "string") {
      throw new CapabilityRouterSettingError(
        CAPABILITY_ROUTER_URLS_SETTING,
        `entry ${index} id must be a string`,
      );
    }
    if (item.token !== undefined && typeof item.token !== "string") {
      throw new CapabilityRouterSettingError(
        CAPABILITY_ROUTER_URLS_SETTING,
        `entry ${index} token must be a string`,
      );
    }
    const id = item.id?.trim();
    if (id && isReservedCapabilityRouterEndpointId(id)) {
      throw new CapabilityRouterSettingError(
        CAPABILITY_ROUTER_URLS_SETTING,
        `entry ${index} id "${id}" is reserved (it names a trust policy option)`,
      );
    }
    const token = item.token?.trim();
    return {
      id: id ? id : fallbackId,
      baseUrl: stripTrailingSlashes(item.baseUrl.trim()),
      ...(token ? { token } : {}),
    };
  });
}

/**
 * Parses ELIZA_CAPABILITY_ROUTER_ALLOWED_MODULES. Returns undefined when unset.
 * Every entry must be an array of strings; blank ids are dropped and empty
 * per-endpoint lists are omitted.
 */
export function parseCapabilityRouterModuleAllowlistSetting(
  value: string | undefined,
): CapabilityRouterModuleAllowlistSetting | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  const key = CAPABILITY_ROUTER_ALLOWED_MODULES_SETTING;
  const parsed = parseJson(key, raw);
  if (Array.isArray(parsed)) {
    return {
      kind: "global",
      moduleIds: requireStringList(key, parsed, "global allowlist"),
    };
  }
  if (!isRecord(parsed)) {
    throw new CapabilityRouterSettingError(
      key,
      "must be a JSON array of module ids or an object keyed by endpoint id",
    );
  }
  const endpoints: Record<string, string[]> = Object.create(null);
  for (const [endpointId, moduleIds] of Object.entries(parsed)) {
    const normalized = requireStringList(
      key,
      moduleIds,
      `entry "${endpointId}"`,
    );
    const id = endpointId.trim();
    if (id && normalized.length > 0) endpoints[id] = normalized;
  }
  return { kind: "endpoints", endpoints };
}

/**
 * Parses ELIZA_CAPABILITY_ROUTER_TRUST_POLICY. Returns undefined when unset.
 * Recognized trust option keys at the top level are global; every other key is
 * an endpoint id whose value must be a policy object. Known option fields must
 * have their documented types (string arrays, string-to-string records,
 * booleans).
 */
export function parseCapabilityRouterTrustPolicySetting(
  value: string | undefined,
): CapabilityRouterTrustPolicySetting | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  const key = CAPABILITY_ROUTER_TRUST_POLICY_SETTING;
  const parsed = parseJson(key, raw);
  if (!isRecord(parsed)) {
    throw new CapabilityRouterSettingError(key, "must be a JSON object");
  }
  const globalFields: Record<string, unknown> = {};
  const endpoints: Record<string, CapabilityRouterTrustPolicySettingValue> =
    Object.create(null);
  for (const [entryKey, entry] of Object.entries(parsed)) {
    if (TRUST_POLICY_FIELD_SET.has(entryKey)) {
      globalFields[entryKey] = entry;
      continue;
    }
    if (!isRecord(entry)) {
      throw new CapabilityRouterSettingError(
        key,
        `entry "${entryKey}" must be a trust policy object`,
      );
    }
    const unknownField = Object.keys(entry).find(
      (field) => !TRUST_POLICY_FIELD_SET.has(field),
    );
    if (unknownField !== undefined) {
      throw new CapabilityRouterSettingError(
        key,
        `entry "${entryKey}" has unknown trust policy option "${unknownField}"`,
      );
    }
    const policy = parseTrustPolicyValue(entry, `entry "${entryKey}"`);
    const id = entryKey.trim();
    if (id && Object.keys(policy).length > 0) endpoints[id] = policy;
  }
  return {
    global: parseTrustPolicyValue(globalFields, "global policy"),
    endpoints,
  };
}

/** Serializes a module allowlist setting back to its stored JSON form. */
export function serializeCapabilityRouterModuleAllowlistSetting(
  setting: CapabilityRouterModuleAllowlistSetting,
): string | undefined {
  if (setting.kind === "global") {
    return setting.moduleIds.length === 0
      ? undefined
      : JSON.stringify(setting.moduleIds);
  }
  return Object.keys(setting.endpoints).length === 0
    ? undefined
    : JSON.stringify(setting.endpoints);
}

/** Serializes a trust policy setting (global keys first) to stored JSON. */
export function serializeCapabilityRouterTrustPolicySetting(
  setting: CapabilityRouterTrustPolicySetting,
): string | undefined {
  for (const endpointId of Object.keys(setting.endpoints)) {
    if (isReservedCapabilityRouterEndpointId(endpointId)) {
      throw new CapabilityRouterSettingError(
        CAPABILITY_ROUTER_TRUST_POLICY_SETTING,
        `endpoint id "${endpointId}" is reserved (it names a trust policy option)`,
      );
    }
  }
  const combined = { ...setting.global, ...setting.endpoints };
  return Object.keys(combined).length === 0
    ? undefined
    : JSON.stringify(combined);
}

function parseTrustPolicyValue(
  record: Record<string, unknown>,
  label: string,
): CapabilityRouterTrustPolicySettingValue {
  const key = CAPABILITY_ROUTER_TRUST_POLICY_SETTING;
  const policy: CapabilityRouterTrustPolicySettingValue = {};
  if (record.allowedProvenanceIssuers !== undefined) {
    const issuers = requireStringList(
      key,
      record.allowedProvenanceIssuers,
      `${label} allowedProvenanceIssuers`,
    );
    if (issuers.length > 0) policy.allowedProvenanceIssuers = issuers;
  }
  if (record.trustedProvenancePublicKeys !== undefined) {
    const keys = record.trustedProvenancePublicKeys;
    if (!isRecord(keys)) {
      throw new CapabilityRouterSettingError(
        key,
        `${label} trustedProvenancePublicKeys must be an object of issuer to public key`,
      );
    }
    const trusted: Record<string, string> = Object.create(null);
    for (const [issuer, publicKey] of Object.entries(keys)) {
      if (typeof publicKey !== "string") {
        throw new CapabilityRouterSettingError(
          key,
          `${label} trustedProvenancePublicKeys.${issuer} must be a string`,
        );
      }
      const nextIssuer = issuer.trim();
      const nextPublicKey = publicKey.trim();
      if (nextIssuer && nextPublicKey) trusted[nextIssuer] = nextPublicKey;
    }
    if (Object.keys(trusted).length > 0) {
      policy.trustedProvenancePublicKeys = trusted;
    }
  }
  for (const flag of [
    "requireSignedProvenance",
    "requireVerifiedProvenance",
    "requireProvenanceDigestMatch",
  ] as const) {
    const flagValue = record[flag];
    if (flagValue === undefined) continue;
    if (typeof flagValue !== "boolean") {
      throw new CapabilityRouterSettingError(
        key,
        `${label} ${flag} must be a boolean`,
      );
    }
    if (flagValue) policy[flag] = true;
  }
  if (policy.requireVerifiedProvenance || policy.requireProvenanceDigestMatch) {
    policy.requireSignedProvenance = true;
  }
  return policy;
}

function requireStringList(
  key: CapabilityRouterSettingKey,
  value: unknown,
  label: string,
): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new CapabilityRouterSettingError(
      key,
      `${label} must be an array of strings`,
    );
  }
  return [
    ...new Set((value as string[]).map((item) => item.trim()).filter(Boolean)),
  ];
}

function parseJson(key: CapabilityRouterSettingKey, raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new CapabilityRouterSettingError(
      key,
      `value is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
      { cause: error },
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripTrailingSlashes(value: string): string {
  return trimEndCharacters(value, "/");
}
