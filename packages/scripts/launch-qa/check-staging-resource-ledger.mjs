#!/usr/bin/env node
/**
 * Validates the public staging-resource ledger as a closed, redacted
 * certification contract. The checker owns the executable Zod schema, the
 * committed JSON Schema projection, the generated Markdown view, and the
 * semantic rules that prevent incomplete or stale evidence from becoming a
 * READY verdict.
 */
import {
  createHash,
  createPublicKey,
  randomBytes,
  verify as verifySignature,
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseDocument, visit } from "yaml";
import { z } from "zod";

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(here, "../../..");

const LEDGER_PATH = ".github/certification/staging-resources.yaml";
const SCHEMA_PATH = ".github/certification/staging-resources.schema.json";
const VIEW_PATH = ".github/certification/staging-resources.md";
const CERTIFICATION_PUBLIC_KEY_PATH =
  ".github/certification/certification-public-key.pem";
const GENERATED_BY =
  "packages/scripts/launch-qa/check-staging-resource-ledger.mjs";
const TRUSTED_CERTIFICATION_KEY_FINGERPRINT = "3ac9e3e625a9ed2f";
const READY_AUTHORIZATION_FORMAT = "elizaos-staging-ready-authorization";
const READY_AUTHORIZATION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_READY_DIMENSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const EVIDENCE_MAX_AGE_MS = {
  provider: 30 * 24 * 60 * 60 * 1000,
  runtime: 7 * 24 * 60 * 60 * 1000,
  smoke: 24 * 60 * 60 * 1000,
};
const PUBLIC_YAML_HEADER = [
  "# Public, redacted staging-resource authority. Private locators and evidence",
  "# remain in the separately approved resolver; never add them to this file.",
];
const ROUTING_SOURCES = new Set([
  "qar-0043",
  "qar-0045",
  "qar-0046",
  "qar-0047",
  "qar-0048",
  "qar-0049",
  "qar-0050",
  "qar-0051",
  "qar-0052",
]);
const ROUTING_TARGETS = new Set(["qar-0053", "qar-0054"]);
const TOP_LEVEL_GROUP_REFS = new Set([
  "qar-0044",
  "qar-0047",
  "qar-0049",
  "qar-0051",
]);

export const CANONICAL_COVERAGE_KEYS = [
  "login-account/account-slot/cloud/fresh-user",
  "login-account/user-account/cloud/returning-user",
  "login-account/mailbox-slot/email/fresh-user",
  "login-account/mailbox/email/returning-user",
  "login-subject/auth-subject/sms/login",
  "login-subject/device-subject/passkey/login",
  "login-subject/auth-subject/google/login",
  "login-subject/auth-subject/discord/login",
  "login-subject/auth-subject/github/login",
  "login-subject/auth-subject/x/login",
  "login-subject/auth-subject/telegram/login",
  "login-subject/wallet-subject/evm/login",
  "login-subject/wallet-subject/solana/login",
  "login-subject/auth-subject/apple/login",
  "provider-owner/service-tenant/steward/auth-service",
  "provider-owner/provider-account/sms/otp-delivery",
  "provider-owner/provider-project/google/oauth-owner",
  "login-application/oauth-client/google/user-oauth",
  "provider-owner/developer-team/apple/oauth-owner",
  "login-application/services-id/apple/user-oauth",
  "provider-owner/provider-account/telegram/oauth-owner",
  "login-application/bot-identity/telegram/login-widget",
  "provider-owner/provider-account/discord/oauth-owner",
  "login-application/oauth-client/discord/user-oauth",
  "provider-owner/provider-account/github/oauth-owner",
  "login-application/oauth-client/github/user-oauth",
  "provider-owner/provider-project/x/oauth-owner",
  "login-application/oauth-client/x/user-oauth",
  "wallet-custody/custody-object/evm/signing",
  "wallet-custody/custody-object/solana/signing",
  "shared-ingress/ingress-application/discord/messaging-ingress",
  "shared-ingress/bot-identity/discord/messaging-ingress",
  "shared-ingress/bot-identity/telegram/messaging-ingress",
  "shared-ingress/provider-account/blooio/messaging-owner",
  "shared-ingress/sender-identity/blooio/messaging-ingress",
  "shared-ingress/channel/blooio/messaging-ingress",
  "provider-owner/provider-account/whatsapp/messaging-owner",
  "shared-ingress/ingress-application/whatsapp/messaging-ingress",
  "shared-ingress/sender-device/whatsapp/messaging-ingress",
  "provider-owner/provider-project/x/messaging-owner",
  "shared-ingress/provider-connection/x/owner-role",
  "shared-ingress/agent-identity/x/agent-role",
  "conversation-fixture/dm/discord/direct-message",
  "conversation-fixture/guild/discord/group-message",
  "conversation-fixture/group-channel/discord/group-message",
  "conversation-fixture/dm/telegram/direct-message",
  "conversation-fixture/group/telegram/group-message",
  "conversation-fixture/dm/blooio/direct-message",
  "conversation-fixture/group/blooio/group-message",
  "conversation-fixture/counterpart/whatsapp/direct-message",
  "conversation-fixture/group/whatsapp/group-message",
  "conversation-fixture/counterpart/x/counterpart",
  "runtime-target/runtime/personal-shared/shared-runtime",
  "runtime-target/organization/dedicated/dedicated-runtime",
  "runtime-target/agent/dedicated/dedicated-runtime",
  "runtime-target/sandbox/dedicated/sandbox-runtime",
];

const CANONICAL_REF_TO_KEY = new Map(
  CANONICAL_COVERAGE_KEYS.map((key, index) => [
    `qar-${String(index + 1).padStart(4, "0")}`,
    key,
  ]),
);
const CANONICAL_REFS = new Set(CANONICAL_REF_TO_KEY.keys());

const CANONICAL_REQUIRED_RELATIONS = new Map([
  ["qar-0001", [["USES", "qar-0003"]]],
  ["qar-0002", [["USES", "qar-0004"]]],
  ["qar-0005", [["DEPENDS_ON", "qar-0016"]]],
  ["qar-0007", [["USES", "qar-0018"]]],
  ["qar-0008", [["USES", "qar-0024"]]],
  ["qar-0009", [["USES", "qar-0026"]]],
  ["qar-0010", [["USES", "qar-0028"]]],
  ["qar-0011", [["USES", "qar-0022"]]],
  ["qar-0012", [["USES", "qar-0029"]]],
  ["qar-0013", [["USES", "qar-0030"]]],
  ["qar-0014", [["USES", "qar-0020"]]],
  ["qar-0018", [["OWNED_BY", "qar-0017"]]],
  ["qar-0020", [["OWNED_BY", "qar-0019"]]],
  ["qar-0022", [["OWNED_BY", "qar-0021"]]],
  ["qar-0024", [["OWNED_BY", "qar-0023"]]],
  ["qar-0026", [["OWNED_BY", "qar-0025"]]],
  ["qar-0028", [["OWNED_BY", "qar-0027"]]],
  ["qar-0031", [["OWNED_BY", "qar-0023"]]],
  ["qar-0032", [["DEPENDS_ON", "qar-0031"]]],
  ["qar-0033", [["OWNED_BY", "qar-0021"]]],
  ["qar-0035", [["OWNED_BY", "qar-0034"]]],
  ["qar-0036", [["DEPENDS_ON", "qar-0035"]]],
  ["qar-0038", [["OWNED_BY", "qar-0037"]]],
  ["qar-0039", [["DEPENDS_ON", "qar-0038"]]],
  ["qar-0041", [["OWNED_BY", "qar-0040"]]],
  ["qar-0042", [["DEPENDS_ON", "qar-0041"]]],
  ["qar-0043", [["USES", "qar-0032"]]],
  [
    "qar-0044",
    [
      ["USES", "qar-0031"],
      ["CONTAINS", "qar-0045"],
    ],
  ],
  [
    "qar-0045",
    [
      ["USES", "qar-0032"],
      ["DEPENDS_ON", "qar-0044"],
    ],
  ],
  ["qar-0046", [["USES", "qar-0033"]]],
  ["qar-0047", [["USES", "qar-0033"]]],
  ["qar-0048", [["USES", "qar-0036"]]],
  ["qar-0049", [["USES", "qar-0036"]]],
  [
    "qar-0050",
    [
      ["USES", "qar-0038"],
      ["DEPENDS_ON", "qar-0039"],
    ],
  ],
  [
    "qar-0051",
    [
      ["USES", "qar-0038"],
      ["DEPENDS_ON", "qar-0039"],
    ],
  ],
  ["qar-0052", [["USES", "qar-0042"]]],
  ["qar-0054", [["CONTAINS", "qar-0055"]]],
  ["qar-0055", [["CONTAINS", "qar-0056"]]],
]);

function capabilityEntries(refs, capabilities) {
  return refs.map((ref) => [ref, capabilities]);
}

const CANONICAL_CAPABILITIES = new Map([
  ...capabilityEntries(
    [
      "qar-0001",
      "qar-0002",
      "qar-0005",
      "qar-0006",
      "qar-0007",
      "qar-0008",
      "qar-0009",
      "qar-0010",
      "qar-0011",
      "qar-0012",
      "qar-0013",
      "qar-0014",
    ],
    ["CENTRAL_ONBOARDING"],
  ),
  ...capabilityEntries(["qar-0003", "qar-0004"], ["FACTOR_DELIVERY"]),
  ...capabilityEntries(
    [
      "qar-0015",
      "qar-0016",
      "qar-0017",
      "qar-0019",
      "qar-0021",
      "qar-0023",
      "qar-0025",
      "qar-0027",
      "qar-0037",
      "qar-0040",
    ],
    ["TEAM_RESOURCE_CUSTODY"],
  ),
  ...capabilityEntries(
    ["qar-0018", "qar-0020", "qar-0022", "qar-0024", "qar-0026", "qar-0028"],
    ["USER_AUTHENTICATION"],
  ),
  ...capabilityEntries(["qar-0029", "qar-0030"], ["CHALLENGE_SIGNING"]),
  ...capabilityEntries(
    [
      "qar-0031",
      "qar-0032",
      "qar-0033",
      "qar-0034",
      "qar-0035",
      "qar-0036",
      "qar-0038",
      "qar-0039",
      "qar-0041",
      "qar-0042",
    ],
    ["SHARED_MESSAGING_INGRESS"],
  ),
  ...capabilityEntries(
    ["qar-0043", "qar-0046", "qar-0048", "qar-0050", "qar-0052"],
    ["CONTROLLED_DIRECT_CONVERSATION", "CENTRAL_ONBOARDING_GATE"],
  ),
  ...capabilityEntries(
    ["qar-0044"],
    ["CONTROLLED_GROUP", "SINGLE_ONBOARDED_OWNER_GUESTS_NO_AUTHORITY"],
  ),
  ...capabilityEntries(
    ["qar-0045", "qar-0047", "qar-0049", "qar-0051"],
    [
      "CONTROLLED_GROUP",
      "SINGLE_ONBOARDED_OWNER_GUESTS_NO_AUTHORITY",
      "CENTRAL_ONBOARDING_GATE",
    ],
  ),
  ...capabilityEntries(["qar-0053"], ["PERSONAL_SHARED_ROUTING"]),
  ...capabilityEntries(
    ["qar-0054", "qar-0055", "qar-0056"],
    ["DEDICATED_RUNTIME_ROUTING"],
  ),
]);

export const COMMON_STATES = [
  "UNKNOWN",
  "REFERENCE_PRESENT",
  "PRESENT",
  "MISSING",
  "ABSENT",
  "PASS",
  "FAIL",
  "FAIL_CURRENT",
  "PARTIAL",
  "NOT_RUN",
  "NOT_REQUIRED",
  "BLOCKED",
  "NON_CERTIFIABLE",
];

export const VERDICT_STATES = [
  "READY",
  "PARTIAL",
  "BLOCKED",
  "NOT_READY",
  "FAIL",
  "FAIL_CURRENT",
  "ABSENT",
  "NON_CERTIFIABLE",
];

export const REASON_CODES = [
  "EVIDENCE_NOT_COLLECTED",
  "NOT_REQUIRED",
  "CERTIFIED",
  "RESOURCE_ABSENT",
  "MAPPING_MISSING",
  "CONFIGURATION_MISSING",
  "CUSTODY_INCOMPLETE",
  "ISOLATION_FAILED",
  "LIFECYCLE_INCOMPLETE",
  "CURRENT_PROVIDER_FAILURE",
  "CURRENT_RUNTIME_FAILURE",
  "SMOKE_FAILED",
  "DEPENDENCY_BLOCKED",
  "PARTIAL_EVIDENCE",
  "NON_CERTIFIABLE_STATE",
  "CERTIFICATION_FAILED",
  "BINDING_REPLACED",
  "EVIDENCE_EXPIRED",
];

export const CONFIGURATION_AUTHORITIES = [
  "UNRESOLVED",
  "GITHUB_ACTIONS",
  "CLOUDFLARE_WORKER",
  "RAILWAY_SERVICE",
  "CONTROL_PLANE",
  "DATABASE",
  "PROVIDER_CONSOLE",
  "DEVICE",
  "SANDBOX",
];

export const RELATION_TYPES = [
  "DEPENDS_ON",
  "OWNED_BY",
  "USES",
  "CONTAINS",
  "ROUTES_TO",
];

const LIFECYCLE_STATES = [
  "UNKNOWN",
  "DOCUMENTED",
  "TESTED",
  "FAIL",
  "MISSING",
  "NOT_REQUIRED",
];
const REUSE_POLICIES = [
  "UNKNOWN",
  "SINGLE_USE",
  "RESET_BETWEEN_RUNS",
  "RENEWABLE",
  "PERSISTENT_STAGING",
  "NOT_REQUIRED",
];
const ROLE_STATES = ["UNKNOWN", "ASSIGNED", "MISSING", "NOT_REQUIRED"];
const RESOLVER_STATES = ["UNKNOWN", "ATTESTED", "MISSING"];
const EXPECTED_BASELINES = ["REQUIRED", "OPTIONAL", "NOT_REQUIRED"];
const NEUTRAL_EVIDENCE_STATES = new Set(["UNKNOWN", "NOT_RUN", "NOT_REQUIRED"]);
const READY_FORBIDDEN_STATES = new Set([
  "UNKNOWN",
  "REFERENCE_PRESENT",
  "MISSING",
  "ABSENT",
  "FAIL",
  "FAIL_CURRENT",
  "PARTIAL",
  "NOT_RUN",
  "BLOCKED",
  "NON_CERTIFIABLE",
]);

const ISO_DATETIME_SCHEMA = z.string().datetime({ offset: true });
const NULLABLE_DATETIME_SCHEMA = ISO_DATETIME_SCHEMA.nullable();
const COMMIT_SCHEMA = z.string().regex(/^[0-9a-f]{40}$/);
const NULLABLE_COMMIT_SCHEMA = COMMIT_SCHEMA.nullable();
const RECEIPT_REF_SCHEMA = z.string().regex(/^rct-[a-z0-9][a-z0-9-]{2,79}$/);
const NULLABLE_RECEIPT_REF_SCHEMA = RECEIPT_REF_SCHEMA.nullable();
const ATTESTATION_REF_SCHEMA = z
  .string()
  .regex(/^att-[a-z0-9][a-z0-9-]{2,79}$/);
const ENVIRONMENT_REF_SCHEMA = z.string().regex(/^[A-Z][A-Z0-9_]{2,79}$/);
const PERMISSION_CAPABILITY_SCHEMA = z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/);
const RESOURCE_REF_SCHEMA = z.string().regex(/^qar-\d{4}$/);
const SLUG_SCHEMA = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const SHA256_SCHEMA = z.string().regex(/^[0-9a-f]{64}$/);
const ED25519_SIGNATURE_SCHEMA = z.string().regex(/^[A-Za-z0-9+/]{86}==$/);

const VerificationRecordSchema = z
  .object({
    state: z.enum(COMMON_STATES),
    checked_at: NULLABLE_DATETIME_SCHEMA,
    receipt_ref: NULLABLE_RECEIPT_REF_SCHEMA,
  })
  .strict();

const EvidenceReceiptSchema = z
  .object({
    state: z.enum(COMMON_STATES),
    receipt_ref: NULLABLE_RECEIPT_REF_SCHEMA,
    observed_at: NULLABLE_DATETIME_SCHEMA,
    valid_until: NULLABLE_DATETIME_SCHEMA,
    source_commit: NULLABLE_COMMIT_SCHEMA,
    binding_generation: z.number().int().positive(),
    reason_code: z.enum(REASON_CODES),
  })
  .strict();

const ReadyAuthorizationSchema = z
  .object({
    payload_version: z.literal(1),
    algorithm: z.literal("Ed25519"),
    key_fingerprint: z.literal(TRUSTED_CERTIFICATION_KEY_FINGERPRINT),
    signed_at: ISO_DATETIME_SCHEMA,
    valid_until: ISO_DATETIME_SCHEMA,
    payload_sha256: SHA256_SCHEMA,
    signature_base64: ED25519_SIGNATURE_SCHEMA,
  })
  .strict();

const ResourceSchema = z
  .object({
    ref: RESOURCE_REF_SCHEMA,
    coverage_key: z.tuple([SLUG_SCHEMA, SLUG_SCHEMA, SLUG_SCHEMA, SLUG_SCHEMA]),
    record_state: z.literal("TRACKED"),
    profile: SLUG_SCHEMA,
    kind: SLUG_SCHEMA,
    surface: SLUG_SCHEMA,
    purpose: SLUG_SCHEMA,
    environment: z.literal("STAGING"),
    binding_generation: z.number().int().positive(),
    relations: z
      .array(
        z
          .object({
            type: z.enum(RELATION_TYPES),
            ref: RESOURCE_REF_SCHEMA,
          })
          .strict(),
      )
      .max(32),
    expected_baseline: z.enum(EXPECTED_BASELINES),
    private_resolver: z
      .object({
        state: z.enum(RESOLVER_STATES),
        attestation_ref: ATTESTATION_REF_SCHEMA.nullable(),
        binding_generation: z.number().int().positive().nullable(),
        checked_at: NULLABLE_DATETIME_SCHEMA,
      })
      .strict(),
    mapping: VerificationRecordSchema,
    existence: VerificationRecordSchema,
    custody: z
      .object({
        primary_role: z.literal("ROLE_STAGING_RESOURCE_PRIMARY"),
        primary_state: z.enum(ROLE_STATES),
        backup_role: z.literal("ROLE_STAGING_RESOURCE_BACKUP"),
        backup_state: z.enum(ROLE_STATES),
        recovery_role: z.literal("ROLE_STAGING_RESOURCE_RECOVERY"),
        recovery_role_state: z.enum(ROLE_STATES),
        mfa_state: z.enum(COMMON_STATES),
        recovery_state: z.enum(COMMON_STATES),
        receipt_ref: NULLABLE_RECEIPT_REF_SCHEMA,
        binding_generation: z.number().int().positive().nullable(),
        checked_at: NULLABLE_DATETIME_SCHEMA,
      })
      .strict(),
    configuration: z
      .array(
        z
          .object({
            authority: z.enum(CONFIGURATION_AUTHORITIES),
            canonical_names: z.array(ENVIRONMENT_REF_SCHEMA).max(32),
            state: z.enum(COMMON_STATES),
            checked_at: NULLABLE_DATETIME_SCHEMA,
            receipt_ref: NULLABLE_RECEIPT_REF_SCHEMA,
          })
          .strict(),
      )
      .min(1)
      .max(16),
    permissions: z
      .object({
        required_capabilities: z.array(PERMISSION_CAPABILITY_SCHEMA).max(32),
        observed_state: z.enum(COMMON_STATES),
        least_privilege_state: z.enum(COMMON_STATES),
        checked_at: NULLABLE_DATETIME_SCHEMA,
        receipt_ref: NULLABLE_RECEIPT_REF_SCHEMA,
      })
      .strict(),
    isolation: z
      .object({
        provider_object: z.enum(COMMON_STATES),
        credentials: z.enum(COMMON_STATES),
        data: z.enum(COMMON_STATES),
        runtime: z.enum(COMMON_STATES),
        production_separation: z.enum(COMMON_STATES),
        checked_at: NULLABLE_DATETIME_SCHEMA,
        receipt_ref: NULLABLE_RECEIPT_REF_SCHEMA,
      })
      .strict(),
    lifecycle: z
      .object({
        reuse_policy: z.enum(REUSE_POLICIES),
        expiry_state: z.enum(LIFECYCLE_STATES),
        reset_state: z.enum(LIFECYCLE_STATES),
        renewal_state: z.enum(LIFECYCLE_STATES),
        rotation_state: z.enum(LIFECYCLE_STATES),
        revocation_state: z.enum(LIFECYCLE_STATES),
        cleanup_state: z.enum(LIFECYCLE_STATES),
        checked_at: NULLABLE_DATETIME_SCHEMA,
        receipt_ref: NULLABLE_RECEIPT_REF_SCHEMA,
      })
      .strict(),
    evidence: z
      .object({
        provider: EvidenceReceiptSchema,
        runtime: EvidenceReceiptSchema,
        smoke: EvidenceReceiptSchema,
      })
      .strict(),
    verdict: z
      .object({
        state: z.enum(VERDICT_STATES),
        evaluated_at: ISO_DATETIME_SCHEMA,
        reason_codes: z.array(z.enum(REASON_CODES)).min(1).max(16),
        blocker_issues: z.array(z.number().int().positive()).max(32),
      })
      .strict(),
  })
  .strict();

export const StagingResourceLedgerSchema = z
  .object({
    format: z.literal("elizaos-staging-resource-ledger"),
    schema_version: z.literal(1),
    ledger_ref: z.literal("qar-ledger-staging"),
    environment: z.literal("STAGING"),
    classification: z.literal("PUBLIC_REDACTED"),
    policy_version: z.literal(1),
    snapshot: z
      .object({
        observed_at: ISO_DATETIME_SCHEMA,
        repository_commit: COMMIT_SCHEMA,
        staging_deployment_commit: COMMIT_SCHEMA,
      })
      .strict(),
    deployment_observation: z
      .object({
        observed_at: ISO_DATETIME_SCHEMA,
        staging_deployment_commit: COMMIT_SCHEMA,
        evidence_alignment: z.enum(["ALIGNED", "REVALIDATION_REQUIRED"]),
      })
      .strict(),
    ready_authorization: ReadyAuthorizationSchema.nullable(),
    resources: z.array(ResourceSchema).length(CANONICAL_COVERAGE_KEYS.length),
  })
  .strict();

function canonicalizeJson(value) {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical JSON cannot encode non-finite numbers.");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalizeJson(entry));
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Canonical JSON accepts plain objects only.");
    }
    const canonical = {};
    for (const key of Object.keys(value).sort()) {
      const child = value[key];
      if (child === undefined) {
        throw new TypeError("Canonical JSON cannot encode undefined values.");
      }
      canonical[key] = canonicalizeJson(child);
    }
    return canonical;
  }
  throw new TypeError("Canonical JSON contains an unsupported value.");
}

function readyAuthorizationMetadata(authorization) {
  if (!authorization || typeof authorization !== "object") {
    throw new TypeError("READY authorization metadata is required.");
  }
  const parsed = z
    .object({
      payload_version: z.literal(1),
      algorithm: z.literal("Ed25519"),
      key_fingerprint: z.literal(TRUSTED_CERTIFICATION_KEY_FINGERPRINT),
      signed_at: ISO_DATETIME_SCHEMA,
      valid_until: ISO_DATETIME_SCHEMA,
    })
    .strict()
    .parse({
      payload_version: authorization.payload_version,
      algorithm: authorization.algorithm,
      key_fingerprint: authorization.key_fingerprint,
      signed_at: authorization.signed_at,
      valid_until: authorization.valid_until,
    });
  return parsed;
}

/**
 * Builds the exact newline-free UTF-8 JSON claim authorized for all current
 * READY rows. Object keys are recursively sorted; array order remains part of
 * the signed contract.
 */
export function buildReadyAuthorizationPayload(ledger, authorization) {
  const metadata = readyAuthorizationMetadata(
    authorization ?? ledger.ready_authorization,
  );
  const payload = {
    format: READY_AUTHORIZATION_FORMAT,
    payload_version: metadata.payload_version,
    ledger_ref: ledger.ledger_ref,
    environment: ledger.environment,
    classification: ledger.classification,
    policy_version: ledger.policy_version,
    snapshot: ledger.snapshot,
    deployment_observation: ledger.deployment_observation,
    authorization: {
      algorithm: metadata.algorithm,
      key_fingerprint: metadata.key_fingerprint,
      signed_at: metadata.signed_at,
      valid_until: metadata.valid_until,
    },
    ready_resources: ledger.resources
      .filter((resource) => resource.verdict.state === "READY")
      .sort((left, right) => left.ref.localeCompare(right.ref)),
  };
  const canonicalJson = JSON.stringify(canonicalizeJson(payload));
  return {
    payload,
    canonicalJson,
    payloadSha256: createHash("sha256").update(canonicalJson).digest("hex"),
  };
}

export function verifyReadyAuthorizationSignature({
  canonicalJson,
  signatureBase64,
  publicKey,
}) {
  let signature;
  try {
    signature = Buffer.from(signatureBase64, "base64");
    if (
      signature.length !== 64 ||
      signature.toString("base64") !== signatureBase64
    ) {
      return false;
    }
    const key =
      publicKey?.type === "public" ? publicKey : createPublicKey(publicKey);
    if (key.asymmetricKeyType !== "ed25519") return false;
    return verifySignature(
      null,
      Buffer.from(canonicalJson, "utf8"),
      key,
      signature,
    );
  } catch {
    // error-policy:J3 Malformed key and signature inputs fail verification.
    return false;
  }
}

const PRIVACY_PATTERNS = [
  {
    label: "email-address",
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  },
  {
    label: "uuid",
    pattern:
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
  },
  {
    label: "ethereum-wallet",
    pattern: /\b0x[0-9a-f]{40}\b/gi,
  },
  {
    label: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  {
    label: "bearer-token",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi,
  },
  {
    label: "provider-token",
    pattern:
      /\b(?:sk-(?:proj-)?|sk-ant-|gh[pousr]_|xox[baprs]-|AIza)[A-Za-z0-9_-]{12,}\b/g,
  },
  {
    label: "credential-value",
    pattern:
      /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|secret|password)\b\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{12,}/gi,
  },
  {
    label: "private-key",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  },
];

const PRIVATE_LOCATOR_KEYS = new Set([
  "account_id",
  "application_id",
  "bot_id",
  "bot_name",
  "channel_id",
  "chat_id",
  "client_id",
  "display_name",
  "email",
  "external_id",
  "guild_id",
  "locator",
  "member_id",
  "owner_name",
  "phone",
  "phone_number",
  "provider_id",
  "provider_object_id",
  "secret_store_path",
  "user_id",
  "username",
  "vault_item",
  "wallet_address",
]);

const MOCK_EVIDENCE_PATTERN =
  /(?:^|[-_/])(?:readme(?:\.md)?|fixtures?|mocks?|__mocks__)(?:[-_/]|$)/i;

function canonicalCoverageKey(tuple) {
  return Array.isArray(tuple) ? tuple.join("/") : "";
}

function artifactPath(repoRoot, relativePath) {
  const resolvedRoot = path.resolve(repoRoot);
  const resolvedPath = path.resolve(resolvedRoot, ...relativePath.split("/"));
  const relative = path.relative(resolvedRoot, resolvedPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Artifact path escapes repository root: ${relativePath}`);
  }
  return resolvedPath;
}

function addError(errors, type, pathValue, message) {
  errors.push({ type, path: pathValue, message });
}

function zodPath(issue) {
  return issue.path.length === 0 ? "$" : `$.${issue.path.join(".")}`;
}

function inspectArtifact(repoRoot, relativePath) {
  let resolvedPath;
  try {
    resolvedPath = artifactPath(repoRoot, relativePath);
  } catch {
    // error-policy:J3 Reject an untrusted path that cannot be contained.
    return { status: "unsafe", path: null };
  }

  const resolvedRoot = path.resolve(repoRoot);
  let rootStats;
  try {
    rootStats = fs.lstatSync(resolvedRoot);
  } catch {
    // error-policy:J3 An unreadable repository root is explicitly unsafe.
    return { status: "unsafe", path: resolvedPath };
  }
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    return { status: "unsafe", path: resolvedPath };
  }

  let current = resolvedRoot;
  const segments = path
    .relative(resolvedRoot, resolvedPath)
    .split(path.sep)
    .filter(Boolean);
  for (const segment of segments) {
    current = path.join(current, segment);
    let stats;
    try {
      stats = fs.lstatSync(current);
    } catch (error) {
      // error-policy:J3 Distinguish an absent artifact from an unsafe path.
      if (error?.code === "ENOENT") {
        return { status: "missing", path: resolvedPath };
      }
      return { status: "unsafe", path: resolvedPath };
    }
    if (stats.isSymbolicLink()) {
      return { status: "unsafe", path: resolvedPath };
    }
    if (current === resolvedPath) {
      return {
        status: stats.isFile() ? "regular" : "unsafe",
        path: resolvedPath,
      };
    }
    if (!stats.isDirectory()) {
      return { status: "unsafe", path: resolvedPath };
    }
  }
  return { status: "unsafe", path: resolvedPath };
}

function readArtifact(repoRoot, relativePath, missingMessage) {
  const inspected = inspectArtifact(repoRoot, relativePath);
  if (inspected.status === "missing") {
    return {
      raw: null,
      error: {
        type: "missing-artifact",
        path: relativePath,
        message: missingMessage,
      },
    };
  }
  if (inspected.status !== "regular" || !inspected.path) {
    return {
      raw: null,
      error: {
        type: "unsafe-artifact",
        path: relativePath,
        message:
          "Certification artifacts must be contained regular files with no symbolic-link path components.",
      },
    };
  }
  try {
    return { raw: fs.readFileSync(inspected.path, "utf8"), error: null };
  } catch {
    // error-policy:J1 Translate filesystem failure into a closed gate result.
    return {
      raw: null,
      error: {
        type: "artifact-read-failure",
        path: relativePath,
        message: "The certification artifact could not be read safely.",
      },
    };
  }
}

function scanYamlStructure(document, errors) {
  let hasAlias = false;
  let hasAnchor = false;
  let hasMergeKey = false;
  visit(document, {
    Node(_key, node) {
      if (node?.anchor) hasAnchor = true;
    },
    Alias() {
      hasAlias = true;
    },
    Pair(_key, pair) {
      if (pair.key?.value === "<<") hasMergeKey = true;
    },
  });
  if (hasAlias) {
    addError(
      errors,
      "forbidden-yaml-alias",
      LEDGER_PATH,
      "YAML aliases are forbidden in the authoritative ledger.",
    );
  }
  if (hasAnchor) {
    addError(
      errors,
      "forbidden-yaml-anchor",
      LEDGER_PATH,
      "YAML anchors are forbidden in the authoritative ledger.",
    );
  }
  if (hasMergeKey) {
    addError(
      errors,
      "forbidden-yaml-merge",
      LEDGER_PATH,
      "YAML merge keys are forbidden in the authoritative ledger.",
    );
  }
  return hasAlias || hasAnchor || hasMergeKey;
}

function lineHasYamlComment(line) {
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (inDoubleQuote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inDoubleQuote = false;
      }
      continue;
    }
    if (inSingleQuote) {
      if (character === "'" && line[index + 1] === "'") {
        index += 1;
      } else if (character === "'") {
        inSingleQuote = false;
      }
      continue;
    }
    if (character === '"') {
      inDoubleQuote = true;
    } else if (character === "'") {
      inSingleQuote = true;
    } else if (
      character === "#" &&
      (index === 0 || /\s/.test(line[index - 1]))
    ) {
      return true;
    }
  }
  return false;
}

function scanYamlComments(raw, errors) {
  const lines = raw.split(/\r?\n/);
  if (
    lines.length < PUBLIC_YAML_HEADER.length ||
    PUBLIC_YAML_HEADER.some((line, index) => lines[index] !== line)
  ) {
    addError(
      errors,
      "invalid-public-header",
      LEDGER_PATH,
      "The authoritative ledger must begin with the fixed two-line public redaction header.",
    );
  }
  if (lines.slice(PUBLIC_YAML_HEADER.length).some(lineHasYamlComment)) {
    addError(
      errors,
      "forbidden-yaml-comment",
      LEDGER_PATH,
      "Only the fixed public redaction header may appear as a YAML comment.",
    );
  }
}

function parseLedger(repoRoot) {
  const loadedArtifact = readArtifact(
    repoRoot,
    LEDGER_PATH,
    "The authoritative staging-resource ledger is missing.",
  );
  if (loadedArtifact.error) {
    return {
      ledger: null,
      raw: null,
      errors: [loadedArtifact.error],
    };
  }

  const raw = loadedArtifact.raw;
  const errors = scanRawPrivacy(raw);
  scanYamlComments(raw, errors);
  let document;
  try {
    document = parseDocument(raw, {
      merge: false,
      schema: "core",
      strict: true,
      uniqueKeys: true,
      version: "1.2",
    });
  } catch {
    // error-policy:J3 Invalid YAML is an explicit rejected input state.
    addError(
      errors,
      "invalid-yaml",
      LEDGER_PATH,
      "The staging-resource ledger is not valid YAML.",
    );
    return { ledger: null, raw, errors };
  }

  if (document.errors.length > 0) {
    for (let index = 0; index < document.errors.length; index += 1) {
      addError(
        errors,
        "invalid-yaml",
        LEDGER_PATH,
        `The staging-resource ledger has YAML parser error ${index + 1}.`,
      );
    }
    return { ledger: null, raw, errors };
  }

  if (document.warnings.length > 0) {
    for (let index = 0; index < document.warnings.length; index += 1) {
      addError(
        errors,
        "invalid-yaml",
        LEDGER_PATH,
        `The staging-resource ledger has YAML parser warning ${index + 1}.`,
      );
    }
    return { ledger: null, raw, errors };
  }

  if (scanYamlStructure(document, errors)) {
    return { ledger: null, raw, errors };
  }

  let candidate;
  try {
    candidate = document.toJS({ maxAliasCount: 0, mapAsMap: false });
  } catch {
    // error-policy:J3 Conversion failures reject the untrusted YAML document.
    addError(
      errors,
      "invalid-yaml",
      LEDGER_PATH,
      "The staging-resource ledger could not be converted safely.",
    );
    return { ledger: null, raw, errors };
  }
  scanStructuredPrivacy(candidate, errors);
  scanMockEvidence(candidate, errors);

  const parsed = StagingResourceLedgerSchema.safeParse(candidate);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const issuePath = zodPath(issue);
      addError(
        errors,
        "schema-validation",
        issuePath,
        `Schema validation failed at ${issuePath} (${issue.code}).`,
      );
    }
    return { ledger: null, raw, errors };
  }

  return { ledger: parsed.data, raw, errors };
}

function scanRawPrivacy(raw) {
  const errors = [];
  for (const { label, pattern } of PRIVACY_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(raw)) {
      addError(
        errors,
        "privacy-violation",
        LEDGER_PATH,
        `The public ledger contains a forbidden ${label}; the value was redacted from this report.`,
      );
    }
  }

  const phoneScan = raw
    .replaceAll(
      /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})\b/g,
      " ",
    )
    .replaceAll(/\b[0-9a-f]{40}\b/gi, " ");
  const phoneCandidates =
    phoneScan.match(
      /(?:^|[^A-Za-z0-9])\+?\d[\d ().-]{7,}\d(?=$|[^A-Za-z0-9])/g,
    ) ?? [];
  if (
    phoneCandidates.some((candidate) => {
      const digits = candidate.replace(/\D/g, "");
      return digits.length >= 9 && digits.length <= 15;
    })
  ) {
    addError(
      errors,
      "privacy-violation",
      LEDGER_PATH,
      "The public ledger contains a forbidden phone-number-like value; the value was redacted from this report.",
    );
  }
  return errors;
}

function scanStructuredPrivacy(value, errors, pathParts = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      scanStructuredPrivacy(item, errors, [...pathParts, String(index)]);
    });
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    const childPath = [...pathParts, key];
    if (PRIVATE_LOCATOR_KEYS.has(key.toLowerCase())) {
      addError(
        errors,
        "private-locator",
        `$.${childPath.join(".")}`,
        "The public ledger contains a forbidden private locator field; its value was not reported.",
      );
    }
    if (
      typeof child === "string" &&
      /^(?:solana|wallet|discord|telegram|whatsapp|imessage|blooio):\/\//i.test(
        child,
      )
    ) {
      addError(
        errors,
        "private-locator",
        `$.${childPath.join(".")}`,
        "The public ledger contains a forbidden provider locator; its value was not reported.",
      );
    }
    if (
      typeof child === "string" &&
      /(?:wallet|address|locator)/i.test(key) &&
      /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(child)
    ) {
      addError(
        errors,
        "privacy-violation",
        `$.${childPath.join(".")}`,
        "The public ledger contains a forbidden wallet-address-like value; the value was not reported.",
      );
    }
    scanStructuredPrivacy(child, errors, childPath);
  }
}

function scanMockEvidence(value, errors, pathParts = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      scanMockEvidence(item, errors, [...pathParts, String(index)]);
    });
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    const childPath = [...pathParts, key];
    if (
      (key === "receipt_ref" || key === "attestation_ref") &&
      typeof child === "string" &&
      MOCK_EVIDENCE_PATTERN.test(child)
    ) {
      addError(
        errors,
        "mock-evidence",
        `$.${childPath.join(".")}`,
        "README, fixture, and mock paths cannot certify a live staging resource.",
      );
    }
    scanMockEvidence(child, errors, childPath);
  }
}

function validateCoverage(ledger, errors) {
  const refCounts = new Map();
  const coverageCounts = new Map();

  ledger.resources.forEach((resource, index) => {
    const resourcePath = `$.resources.${index}`;
    const expectedRef = `qar-${String(index + 1).padStart(4, "0")}`;
    if (resource.ref !== expectedRef) {
      addError(
        errors,
        "resource-order",
        `${resourcePath}.ref`,
        `Resources must be ordered canonically; this row must be ${expectedRef}.`,
      );
    }
    refCounts.set(resource.ref, (refCounts.get(resource.ref) ?? 0) + 1);
    const coverageKey = canonicalCoverageKey(resource.coverage_key);
    coverageCounts.set(coverageKey, (coverageCounts.get(coverageKey) ?? 0) + 1);

    if (!CANONICAL_REFS.has(resource.ref)) {
      addError(
        errors,
        "invalid-resource-ref",
        `${resourcePath}.ref`,
        "Resource refs must use the complete opaque qar-0001 through qar-0056 allocation.",
      );
    }
    const expectedKey = CANONICAL_REF_TO_KEY.get(resource.ref);
    if (expectedKey && expectedKey !== coverageKey) {
      addError(
        errors,
        "coverage-ref-mismatch",
        `${resourcePath}.coverage_key`,
        "The coverage tuple does not match the canonical opaque resource ref.",
      );
    }

    const tupleFields = [
      resource.profile,
      resource.kind,
      resource.surface,
      resource.purpose,
    ];
    if (tupleFields.join("/") !== coverageKey) {
      addError(
        errors,
        "coverage-field-mismatch",
        `${resourcePath}.coverage_key`,
        "profile, kind, surface, and purpose must reproduce coverage_key exactly.",
      );
    }

    const expectedBaseline = ["qar-0014", "qar-0019", "qar-0020"].includes(
      resource.ref,
    )
      ? "OPTIONAL"
      : "REQUIRED";
    if (resource.expected_baseline !== expectedBaseline) {
      addError(
        errors,
        "baseline-mismatch",
        `${resourcePath}.expected_baseline`,
        `${resource.ref} must use the canonical ${expectedBaseline} launch baseline.`,
      );
    }
  });

  for (const ref of CANONICAL_REFS) {
    const count = refCounts.get(ref) ?? 0;
    if (count === 0) {
      addError(
        errors,
        "missing-resource-ref",
        "$.resources",
        `Required opaque resource ref ${ref} is missing.`,
      );
    } else if (count > 1) {
      addError(
        errors,
        "duplicate-resource-ref",
        "$.resources",
        `Opaque resource ref ${ref} appears more than once.`,
      );
    }
  }

  for (const coverageKey of CANONICAL_COVERAGE_KEYS) {
    const count = coverageCounts.get(coverageKey) ?? 0;
    if (count === 0) {
      addError(
        errors,
        "missing-coverage",
        "$.resources",
        `Required coverage tuple ${coverageKey} is missing.`,
      );
    } else if (count > 1) {
      addError(
        errors,
        "duplicate-coverage",
        "$.resources",
        `Coverage tuple ${coverageKey} appears more than once.`,
      );
    }
  }
}

function validateRelations(ledger, errors) {
  const refs = new Set(ledger.resources.map((resource) => resource.ref));
  ledger.resources.forEach((resource, resourceIndex) => {
    const relationKeys = new Set();
    resource.relations.forEach((relation, relationIndex) => {
      const relationPath = `$.resources.${resourceIndex}.relations.${relationIndex}`;
      if (relation.ref === resource.ref) {
        addError(
          errors,
          "self-relation",
          `${relationPath}.ref`,
          "A resource cannot relate to itself.",
        );
      }
      if (!refs.has(relation.ref)) {
        addError(
          errors,
          "unresolved-relation",
          `${relationPath}.ref`,
          "The related opaque resource ref does not exist in this ledger.",
        );
      }
      const key = `${relation.type}:${relation.ref}`;
      if (relationKeys.has(key)) {
        addError(
          errors,
          "duplicate-relation",
          relationPath,
          "A resource relation tuple may appear only once.",
        );
      }
      relationKeys.add(key);
    });
    for (const [type, ref] of CANONICAL_REQUIRED_RELATIONS.get(resource.ref) ??
      []) {
      if (!relationKeys.has(`${type}:${ref}`)) {
        addError(
          errors,
          "missing-canonical-relation",
          `$.resources.${resourceIndex}.relations`,
          `${resource.ref} must retain its canonical ${type} relation to ${ref}.`,
        );
      }
    }

    const routingTargets = resource.relations
      .filter((relation) => relation.type === "ROUTES_TO")
      .map((relation) => relation.ref);
    if (ROUTING_SOURCES.has(resource.ref)) {
      if (
        routingTargets.length !== ROUTING_TARGETS.size ||
        routingTargets.some((ref) => !ROUTING_TARGETS.has(ref))
      ) {
        addError(
          errors,
          "routing-contract",
          `$.resources.${resourceIndex}.relations`,
          `${resource.ref} must route to both supported runtime aggregates qar-0053 and qar-0054 exactly once.`,
        );
      }
    } else if (routingTargets.length > 0) {
      addError(
        errors,
        "routing-contract",
        `$.resources.${resourceIndex}.relations`,
        `${resource.ref} is not a canonical conversation fixture and cannot declare ROUTES_TO.`,
      );
    }

    const ownedByTargets = resource.relations
      .filter((relation) => relation.type === "OWNED_BY")
      .map((relation) => relation.ref);
    if (TOP_LEVEL_GROUP_REFS.has(resource.ref)) {
      if (ownedByTargets.length !== 1 || ownedByTargets[0] !== "qar-0002") {
        addError(
          errors,
          "group-owner-contract",
          `$.resources.${resourceIndex}.relations`,
          `${resource.ref} must be owned exactly once by the onboarded staging account qar-0002.`,
        );
      }
    } else if (ownedByTargets.includes("qar-0002")) {
      addError(
        errors,
        "group-owner-contract",
        `$.resources.${resourceIndex}.relations`,
        "Only canonical top-level group fixtures may be owned directly by qar-0002.",
      );
    }
    if (resource.ref === "qar-0045" && ownedByTargets.length > 0) {
      addError(
        errors,
        "group-owner-contract",
        `$.resources.${resourceIndex}.relations`,
        "qar-0045 inherits guild ownership through qar-0044 and cannot declare a second owner.",
      );
    }
  });
}

function validateConfiguration(ledger, errors) {
  ledger.resources.forEach((resource, resourceIndex) => {
    resource.configuration.forEach((configuration, configIndex) => {
      const configPath = `$.resources.${resourceIndex}.configuration.${configIndex}`;
      if (
        configuration.authority === "UNRESOLVED" &&
        configuration.canonical_names.length > 0
      ) {
        addError(
          errors,
          "unresolved-configuration-names",
          `${configPath}.canonical_names`,
          "UNRESOLVED configuration cannot claim canonical binding names.",
        );
      }
      if (
        configuration.authority !== "UNRESOLVED" &&
        configuration.state !== "NOT_REQUIRED" &&
        configuration.canonical_names.length === 0
      ) {
        addError(
          errors,
          "missing-configuration-names",
          `${configPath}.canonical_names`,
          "A resolved configuration authority requires at least one generic canonical binding name.",
        );
      }
      const names = new Set(configuration.canonical_names);
      if (names.size !== configuration.canonical_names.length) {
        addError(
          errors,
          "duplicate-configuration-name",
          `${configPath}.canonical_names`,
          "Canonical configuration names must be unique within one authority record.",
        );
      }
    });
  });
}

function validatePermissions(ledger, errors) {
  ledger.resources.forEach((resource, resourceIndex) => {
    const capabilities = resource.permissions.required_capabilities;
    if (new Set(capabilities).size !== capabilities.length) {
      addError(
        errors,
        "duplicate-permission-capability",
        `$.resources.${resourceIndex}.permissions.required_capabilities`,
        "Required permission capabilities must be unique.",
      );
    }
    const expected = CANONICAL_CAPABILITIES.get(resource.ref);
    if (
      !expected ||
      capabilities.length !== expected.length ||
      capabilities.some((capability, index) => capability !== expected[index])
    ) {
      addError(
        errors,
        "capability-contract",
        `$.resources.${resourceIndex}.permissions.required_capabilities`,
        "Required capabilities must match the canonical launch and group-ownership contract exactly.",
      );
    }
  });
}

function validateReceiptPair(errors, state, checkedAt, receiptRef, recordPath) {
  const isNeutral = NEUTRAL_EVIDENCE_STATES.has(state);
  if (isNeutral && (checkedAt !== null || receiptRef !== null)) {
    addError(
      errors,
      "neutral-receipt",
      recordPath,
      `State ${state} requires checked_at and receipt_ref to be null.`,
    );
  } else if (!isNeutral && (checkedAt === null || receiptRef === null)) {
    addError(
      errors,
      "incomplete-receipt",
      recordPath,
      `State ${state} requires both checked_at and receipt_ref.`,
    );
  }
}

function validateSectionReceipt(
  errors,
  states,
  checkedAt,
  receiptRef,
  sectionPath,
) {
  const isNeutral = states.every((state) => NEUTRAL_EVIDENCE_STATES.has(state));
  if (isNeutral && (checkedAt !== null || receiptRef !== null)) {
    addError(
      errors,
      "neutral-receipt",
      sectionPath,
      "A fully neutral section requires checked_at and receipt_ref to be null.",
    );
  } else if (!isNeutral && (checkedAt === null || receiptRef === null)) {
    addError(
      errors,
      "incomplete-receipt",
      sectionPath,
      "A section with a material state requires both checked_at and receipt_ref.",
    );
  }
}

function validateReceiptCoherence(ledger, errors) {
  ledger.resources.forEach((resource, resourceIndex) => {
    const resourcePath = `$.resources.${resourceIndex}`;
    for (const field of ["mapping", "existence"]) {
      const record = resource[field];
      validateReceiptPair(
        errors,
        record.state,
        record.checked_at,
        record.receipt_ref,
        `${resourcePath}.${field}`,
      );
    }

    resource.configuration.forEach((configuration, configIndex) => {
      validateReceiptPair(
        errors,
        configuration.state,
        configuration.checked_at,
        configuration.receipt_ref,
        `${resourcePath}.configuration.${configIndex}`,
      );
    });

    validateSectionReceipt(
      errors,
      [
        resource.permissions.observed_state,
        resource.permissions.least_privilege_state,
      ],
      resource.permissions.checked_at,
      resource.permissions.receipt_ref,
      `${resourcePath}.permissions`,
    );
    validateSectionReceipt(
      errors,
      [
        resource.isolation.provider_object,
        resource.isolation.credentials,
        resource.isolation.data,
        resource.isolation.runtime,
        resource.isolation.production_separation,
      ],
      resource.isolation.checked_at,
      resource.isolation.receipt_ref,
      `${resourcePath}.isolation`,
    );
    validateSectionReceipt(
      errors,
      [
        resource.lifecycle.expiry_state,
        resource.lifecycle.reset_state,
        resource.lifecycle.renewal_state,
        resource.lifecycle.rotation_state,
        resource.lifecycle.revocation_state,
        resource.lifecycle.cleanup_state,
      ],
      resource.lifecycle.checked_at,
      resource.lifecycle.receipt_ref,
      `${resourcePath}.lifecycle`,
    );

    const custodyStates = [
      resource.custody.primary_state,
      resource.custody.backup_state,
      resource.custody.recovery_role_state,
      resource.custody.mfa_state,
      resource.custody.recovery_state,
    ];
    const custodyIsNeutral = custodyStates.every(
      (state) => state === "UNKNOWN" || state === "NOT_REQUIRED",
    );
    const custodyBindingFields = [
      resource.custody.receipt_ref,
      resource.custody.binding_generation,
      resource.custody.checked_at,
    ];
    if (
      custodyIsNeutral &&
      custodyBindingFields.some((field) => field !== null)
    ) {
      addError(
        errors,
        "neutral-receipt",
        `${resourcePath}.custody`,
        "Fully neutral custody requires receipt_ref, binding_generation, and checked_at to be null.",
      );
    } else if (
      !custodyIsNeutral &&
      custodyBindingFields.some((field) => field === null)
    ) {
      addError(
        errors,
        "incomplete-receipt",
        `${resourcePath}.custody`,
        "Material custody findings require a receipt, current binding generation, and checked_at.",
      );
    }
    if (
      resource.custody.binding_generation !== null &&
      resource.custody.binding_generation !== resource.binding_generation
    ) {
      addError(
        errors,
        "binding-generation-mismatch",
        `${resourcePath}.custody.binding_generation`,
        "Custody may certify only the current resource binding generation.",
      );
    }

    const resolver = resource.private_resolver;
    const resolverBindingFields = [
      resolver.attestation_ref,
      resolver.binding_generation,
      resolver.checked_at,
    ];
    if (
      resolver.state === "ATTESTED" &&
      resolverBindingFields.some((field) => field === null)
    ) {
      addError(
        errors,
        "resolver-attestation",
        `${resourcePath}.private_resolver`,
        "An ATTESTED private resolver requires an attestation ref, current binding generation, and checked_at.",
      );
    } else if (
      resolver.state !== "ATTESTED" &&
      resolverBindingFields.some((field) => field !== null)
    ) {
      addError(
        errors,
        "resolver-attestation",
        `${resourcePath}.private_resolver`,
        "A non-attested private resolver requires attestation_ref, binding_generation, and checked_at to be null.",
      );
    }
    if (
      resolver.binding_generation !== null &&
      resolver.binding_generation !== resource.binding_generation
    ) {
      addError(
        errors,
        "binding-generation-mismatch",
        `${resourcePath}.private_resolver.binding_generation`,
        "The private-resolver attestation may certify only the current resource binding generation.",
      );
    }
  });
}

function validateReceiptUniqueness(ledger, errors) {
  const seen = new Map();
  const record = (receiptRef, receiptPath) => {
    if (receiptRef === null) return;
    const previousPath = seen.get(receiptRef);
    if (previousPath) {
      addError(
        errors,
        "duplicate-receipt-ref",
        receiptPath,
        `Receipt refs are globally unique; this one is already used at ${previousPath}.`,
      );
      return;
    }
    seen.set(receiptRef, receiptPath);
  };

  ledger.resources.forEach((resource, resourceIndex) => {
    const resourcePath = `$.resources.${resourceIndex}`;
    record(resource.mapping.receipt_ref, `${resourcePath}.mapping.receipt_ref`);
    record(
      resource.existence.receipt_ref,
      `${resourcePath}.existence.receipt_ref`,
    );
    record(resource.custody.receipt_ref, `${resourcePath}.custody.receipt_ref`);
    resource.configuration.forEach((configuration, configIndex) => {
      record(
        configuration.receipt_ref,
        `${resourcePath}.configuration.${configIndex}.receipt_ref`,
      );
    });
    for (const [sectionName, section] of [
      ["permissions", resource.permissions],
      ["isolation", resource.isolation],
      ["lifecycle", resource.lifecycle],
    ]) {
      record(section.receipt_ref, `${resourcePath}.${sectionName}.receipt_ref`);
    }
    for (const evidenceKind of ["provider", "runtime", "smoke"]) {
      record(
        resource.evidence[evidenceKind].receipt_ref,
        `${resourcePath}.evidence.${evidenceKind}.receipt_ref`,
      );
    }
  });
}

function validateVerdicts(ledger, errors) {
  ledger.resources.forEach((resource, resourceIndex) => {
    const blockers = resource.verdict.blocker_issues;
    if (resource.verdict.state === "READY" && blockers.length > 0) {
      addError(
        errors,
        "ready-blockers",
        `$.resources.${resourceIndex}.verdict.blocker_issues`,
        "READY resources cannot retain blocker issues.",
      );
    } else if (resource.verdict.state !== "READY" && blockers.length === 0) {
      addError(
        errors,
        "missing-blocker",
        `$.resources.${resourceIndex}.verdict.blocker_issues`,
        "Every non-READY resource must identify at least one tracking issue.",
      );
    }
    if (new Set(blockers).size !== blockers.length) {
      addError(
        errors,
        "duplicate-blocker",
        `$.resources.${resourceIndex}.verdict.blocker_issues`,
        "Blocker issue numbers must be unique within a resource verdict.",
      );
    }
  });
}

function validateTimestamp(
  errors,
  timestamp,
  timestampPath,
  snapshotTime,
  nowTime,
) {
  if (timestamp === null) return;
  const value = Date.parse(timestamp);
  if (value > snapshotTime) {
    addError(
      errors,
      "post-snapshot-timestamp",
      timestampPath,
      "Receipt timestamps cannot be later than snapshot.observed_at.",
    );
  }
  if (value > nowTime) {
    addError(
      errors,
      "future-timestamp",
      timestampPath,
      "Receipt timestamps cannot be in the future.",
    );
  }
}

function validateTimestamps(ledger, errors, now) {
  const snapshotTime = Date.parse(ledger.snapshot.observed_at);
  const deploymentTime = Date.parse(ledger.deployment_observation.observed_at);
  const nowTime = now.getTime();
  if (snapshotTime > nowTime) {
    addError(
      errors,
      "future-snapshot",
      "$.snapshot.observed_at",
      "The ledger snapshot cannot be in the future.",
    );
  }
  if (deploymentTime > nowTime) {
    addError(
      errors,
      "future-deployment-observation",
      "$.deployment_observation.observed_at",
      "The staging deployment observation cannot be in the future.",
    );
  }
  if (deploymentTime < snapshotTime) {
    addError(
      errors,
      "stale-deployment-observation",
      "$.deployment_observation.observed_at",
      "The staging deployment observation must be at least as recent as the evidence snapshot.",
    );
  }

  ledger.resources.forEach((resource, resourceIndex) => {
    const resourcePath = `$.resources.${resourceIndex}`;
    for (const field of ["mapping", "existence"]) {
      validateTimestamp(
        errors,
        resource[field].checked_at,
        `${resourcePath}.${field}.checked_at`,
        snapshotTime,
        nowTime,
      );
    }
    resource.configuration.forEach((configuration, configIndex) => {
      validateTimestamp(
        errors,
        configuration.checked_at,
        `${resourcePath}.configuration.${configIndex}.checked_at`,
        snapshotTime,
        nowTime,
      );
    });
    for (const [sectionName, section] of [
      ["private_resolver", resource.private_resolver],
      ["custody", resource.custody],
      ["permissions", resource.permissions],
      ["isolation", resource.isolation],
      ["lifecycle", resource.lifecycle],
    ]) {
      validateTimestamp(
        errors,
        section.checked_at,
        `${resourcePath}.${sectionName}.checked_at`,
        snapshotTime,
        nowTime,
      );
    }
    validateTimestamp(
      errors,
      resource.verdict.evaluated_at,
      `${resourcePath}.verdict.evaluated_at`,
      snapshotTime,
      nowTime,
    );
    for (const evidenceKind of ["provider", "runtime", "smoke"]) {
      validateTimestamp(
        errors,
        resource.evidence[evidenceKind].observed_at,
        `${resourcePath}.evidence.${evidenceKind}.observed_at`,
        snapshotTime,
        nowTime,
      );
    }
  });
}

function validateDeploymentObservation(ledger, errors) {
  const commitsMatch =
    ledger.deployment_observation.staging_deployment_commit ===
    ledger.snapshot.staging_deployment_commit;
  const expectedAlignment = commitsMatch ? "ALIGNED" : "REVALIDATION_REQUIRED";
  if (ledger.deployment_observation.evidence_alignment !== expectedAlignment) {
    addError(
      errors,
      "deployment-alignment",
      "$.deployment_observation.evidence_alignment",
      commitsMatch
        ? "A staging deployment matching the evidence snapshot must be ALIGNED."
        : "A staging deployment that differs from the evidence snapshot requires REVALIDATION_REQUIRED.",
    );
  }
  if (
    !commitsMatch &&
    ledger.resources.some((resource) => resource.verdict.state === "READY")
  ) {
    addError(
      errors,
      "deployment-revalidation-required",
      "$.resources",
      "No resource may be READY while the observed staging deployment requires evidence revalidation.",
    );
  }
}

function loadTrustedCertificationKey(repoRoot, errors) {
  const loadedKey = readArtifact(
    repoRoot,
    CERTIFICATION_PUBLIC_KEY_PATH,
    "The committed certification public key is missing.",
  );
  if (loadedKey.error) {
    errors.push(loadedKey.error);
    return null;
  }
  try {
    const key = createPublicKey(loadedKey.raw);
    if (key.asymmetricKeyType !== "ed25519") {
      throw new TypeError("The certification key is not Ed25519.");
    }
    const canonicalPem = key.export({ type: "spki", format: "pem" });
    if (loadedKey.raw !== canonicalPem) {
      addError(
        errors,
        "noncanonical-certification-key",
        CERTIFICATION_PUBLIC_KEY_PATH,
        "The certification key file must contain exactly one canonical public SPKI PEM block and no trailing content.",
      );
      return null;
    }
    const fingerprint = createHash("sha256")
      .update(key.export({ type: "spki", format: "der" }))
      .digest("hex")
      .slice(0, 16);
    if (fingerprint !== TRUSTED_CERTIFICATION_KEY_FINGERPRINT) {
      addError(
        errors,
        "certification-key-anchor",
        CERTIFICATION_PUBLIC_KEY_PATH,
        "The committed certification key does not match the hardcoded staging trust anchor.",
      );
      return null;
    }
    return key;
  } catch {
    // error-policy:J3 Invalid public-key material fails the certification gate.
    addError(
      errors,
      "invalid-certification-key",
      CERTIFICATION_PUBLIC_KEY_PATH,
      "The committed certification public key is not a valid Ed25519 key.",
    );
    return null;
  }
}

function validateReadyAuthorization(ledger, errors, now, trustedKey) {
  const readyCount = ledger.resources.filter(
    (resource) => resource.verdict.state === "READY",
  ).length;
  const authorization = ledger.ready_authorization;
  if (readyCount === 0) {
    if (authorization !== null) {
      addError(
        errors,
        "unexpected-ready-authorization",
        "$.ready_authorization",
        "ready_authorization must be null while the ledger has no READY resources.",
      );
    }
    return;
  }
  if (authorization === null) {
    addError(
      errors,
      "missing-ready-authorization",
      "$.ready_authorization",
      "At least one READY resource requires a signed authorization envelope.",
    );
    return;
  }

  const nowTime = now.getTime();
  const signedAt = Date.parse(authorization.signed_at);
  const validUntil = Date.parse(authorization.valid_until);
  const latestObservation = Math.max(
    Date.parse(ledger.snapshot.observed_at),
    Date.parse(ledger.deployment_observation.observed_at),
  );
  if (signedAt > nowTime) {
    addError(
      errors,
      "future-ready-authorization",
      "$.ready_authorization.signed_at",
      "READY authorization cannot be signed in the future.",
    );
  }
  if (signedAt < latestObservation) {
    addError(
      errors,
      "stale-ready-authorization",
      "$.ready_authorization.signed_at",
      "READY authorization must be signed after the snapshot and deployment observation.",
    );
  }
  if (nowTime - signedAt > READY_AUTHORIZATION_MAX_AGE_MS) {
    addError(
      errors,
      "stale-ready-authorization",
      "$.ready_authorization.signed_at",
      "READY authorization is older than its maximum 24-hour age.",
    );
  }
  if (validUntil <= signedAt) {
    addError(
      errors,
      "invalid-ready-authorization-window",
      "$.ready_authorization.valid_until",
      "READY authorization must expire after it is signed.",
    );
  }
  if (validUntil - signedAt > READY_AUTHORIZATION_MAX_AGE_MS) {
    addError(
      errors,
      "invalid-ready-authorization-window",
      "$.ready_authorization.valid_until",
      "READY authorization lifetime cannot exceed 24 hours.",
    );
  }
  if (validUntil <= nowTime) {
    addError(
      errors,
      "expired-ready-authorization",
      "$.ready_authorization.valid_until",
      "READY authorization has expired.",
    );
  }

  const payload = buildReadyAuthorizationPayload(ledger, authorization);
  if (payload.payloadSha256 !== authorization.payload_sha256) {
    addError(
      errors,
      "ready-authorization-payload-mismatch",
      "$.ready_authorization.payload_sha256",
      "READY authorization does not cover the current canonical public claim.",
    );
  }
  if (
    !trustedKey ||
    !verifyReadyAuthorizationSignature({
      canonicalJson: payload.canonicalJson,
      signatureBase64: authorization.signature_base64,
      publicKey: trustedKey,
    })
  ) {
    addError(
      errors,
      "invalid-ready-authorization-signature",
      "$.ready_authorization.signature_base64",
      "READY authorization signature is invalid for the anchored certification key.",
    );
  }
}

function validateEvidence(ledger, errors) {
  const reasonByState = {
    UNKNOWN: ["EVIDENCE_NOT_COLLECTED"],
    REFERENCE_PRESENT: ["PARTIAL_EVIDENCE"],
    PRESENT: ["PARTIAL_EVIDENCE"],
    MISSING: ["RESOURCE_ABSENT"],
    ABSENT: ["RESOURCE_ABSENT"],
    PASS: ["CERTIFIED"],
    PARTIAL: ["PARTIAL_EVIDENCE"],
    NOT_RUN: ["EVIDENCE_NOT_COLLECTED"],
    NOT_REQUIRED: ["NOT_REQUIRED"],
    BLOCKED: ["DEPENDENCY_BLOCKED"],
    NON_CERTIFIABLE: ["NON_CERTIFIABLE_STATE"],
  };
  ledger.resources.forEach((resource, resourceIndex) => {
    for (const evidenceKind of ["provider", "runtime", "smoke"]) {
      const evidence = resource.evidence[evidenceKind];
      const evidencePath = `$.resources.${resourceIndex}.evidence.${evidenceKind}`;
      const expectedReasons =
        evidence.state === "FAIL" || evidence.state === "FAIL_CURRENT"
          ? [
              evidenceKind === "provider"
                ? "CURRENT_PROVIDER_FAILURE"
                : evidenceKind === "runtime"
                  ? "CURRENT_RUNTIME_FAILURE"
                  : "SMOKE_FAILED",
            ]
          : reasonByState[evidence.state];
      if (!expectedReasons?.includes(evidence.reason_code)) {
        addError(
          errors,
          "evidence-reason-mismatch",
          `${evidencePath}.reason_code`,
          `Evidence state ${evidence.state} is inconsistent with its reason code.`,
        );
      }
      if (evidence.binding_generation !== resource.binding_generation) {
        addError(
          errors,
          "binding-generation-mismatch",
          `${evidencePath}.binding_generation`,
          "Evidence may certify only the current resource binding generation.",
        );
      }

      if (NEUTRAL_EVIDENCE_STATES.has(evidence.state)) {
        for (const field of [
          "receipt_ref",
          "observed_at",
          "valid_until",
          "source_commit",
        ]) {
          if (evidence[field] !== null) {
            addError(
              errors,
              "neutral-evidence-receipt",
              `${evidencePath}.${field}`,
              `UNKNOWN, NOT_RUN, and NOT_REQUIRED evidence require ${field} to be null.`,
            );
          }
        }
      } else {
        for (const field of ["receipt_ref", "observed_at", "source_commit"]) {
          if (evidence[field] === null) {
            addError(
              errors,
              "incomplete-evidence-receipt",
              `${evidencePath}.${field}`,
              `Evidence state ${evidence.state} requires ${field}.`,
            );
          }
        }
        if (
          evidence.source_commit !== null &&
          ![
            ledger.snapshot.repository_commit,
            ledger.snapshot.staging_deployment_commit,
          ].includes(evidence.source_commit)
        ) {
          addError(
            errors,
            "evidence-source-mismatch",
            `${evidencePath}.source_commit`,
            "Current evidence must identify one of the snapshot commits.",
          );
        }
      }

      if (evidence.state === "PASS" && evidence.valid_until === null) {
        addError(
          errors,
          "missing-evidence-expiry",
          `${evidencePath}.valid_until`,
          "PASS evidence requires an explicit validity deadline.",
        );
      }
      if (
        evidence.observed_at !== null &&
        evidence.valid_until !== null &&
        Date.parse(evidence.valid_until) <= Date.parse(evidence.observed_at)
      ) {
        addError(
          errors,
          "invalid-evidence-window",
          `${evidencePath}.valid_until`,
          "Evidence validity cannot end before it was observed.",
        );
      }
    }
  });
}

function addReadyInvariant(errors, resourceIndex, pathSuffix, message) {
  addError(
    errors,
    "ready-invariant",
    `$.resources.${resourceIndex}.${pathSuffix}`,
    message,
  );
}

function validateReadyTimestamp(
  errors,
  resourceIndex,
  pathSuffix,
  timestamp,
  nowTime,
  maxAgeMs = DEFAULT_READY_DIMENSION_MAX_AGE_MS,
) {
  if (timestamp === null) return;
  if (nowTime - Date.parse(timestamp) > maxAgeMs) {
    addReadyInvariant(
      errors,
      resourceIndex,
      pathSuffix,
      "READY evidence is older than its allowed certification window.",
    );
  }
}

function validateReadyResources(ledger, errors, now) {
  const nowTime = now.getTime();
  const resourcesByRef = new Map(
    ledger.resources.map((resource) => [resource.ref, resource]),
  );
  const readyResources = ledger.resources.filter(
    (resource) => resource.verdict.state === "READY",
  );
  if (readyResources.length > 0) {
    for (const [pathSuffix, timestamp] of [
      ["snapshot.observed_at", ledger.snapshot.observed_at],
      [
        "deployment_observation.observed_at",
        ledger.deployment_observation.observed_at,
      ],
    ]) {
      if (
        nowTime - Date.parse(timestamp) >
        DEFAULT_READY_DIMENSION_MAX_AGE_MS
      ) {
        addError(
          errors,
          "ready-invariant",
          `$.${pathSuffix}`,
          "READY requires a current snapshot and staging deployment observation no older than seven days.",
        );
      }
    }
  }

  ledger.resources.forEach((resource, resourceIndex) => {
    if (resource.verdict.state !== "READY") {
      return;
    }

    if (
      resource.verdict.blocker_issues.length > 0 ||
      resource.verdict.reason_codes.length !== 1 ||
      resource.verdict.reason_codes[0] !== "CERTIFIED"
    ) {
      addReadyInvariant(
        errors,
        resourceIndex,
        "verdict",
        "READY requires reason code CERTIFIED and no blocker issues.",
      );
    }

    if (resource.expected_baseline === "NOT_REQUIRED") {
      addReadyInvariant(
        errors,
        resourceIndex,
        "expected_baseline",
        "READY cannot certify a resource outside the expected baseline.",
      );
    }
    if (
      resource.private_resolver.state !== "ATTESTED" ||
      resource.private_resolver.attestation_ref === null ||
      resource.private_resolver.binding_generation !==
        resource.binding_generation ||
      resource.private_resolver.checked_at === null
    ) {
      addReadyInvariant(
        errors,
        resourceIndex,
        "private_resolver",
        "READY requires an attested private resolver without publishing its locator.",
      );
    }
    validateReadyTimestamp(
      errors,
      resourceIndex,
      "private_resolver.checked_at",
      resource.private_resolver.checked_at,
      nowTime,
    );

    for (const [field, record] of [
      ["mapping", resource.mapping],
      ["existence", resource.existence],
    ]) {
      if (
        !["PASS", "PRESENT"].includes(record.state) ||
        record.checked_at === null ||
        record.receipt_ref === null
      ) {
        addReadyInvariant(
          errors,
          resourceIndex,
          field,
          `READY requires complete, dated ${field} evidence.`,
        );
      }
      validateReadyTimestamp(
        errors,
        resourceIndex,
        `${field}.checked_at`,
        record.checked_at,
        nowTime,
      );
    }

    for (const field of [
      "primary_state",
      "backup_state",
      "recovery_role_state",
    ]) {
      if (resource.custody[field] !== "ASSIGNED") {
        addReadyInvariant(
          errors,
          resourceIndex,
          `custody.${field}`,
          "READY requires assigned primary, backup, and recovery roles.",
        );
      }
    }
    for (const field of ["mfa_state", "recovery_state"]) {
      if (!["PASS", "NOT_REQUIRED"].includes(resource.custody[field])) {
        addReadyInvariant(
          errors,
          resourceIndex,
          `custody.${field}`,
          `READY requires custody ${field} to be PASS or NOT_REQUIRED.`,
        );
      }
    }
    if (
      resource.custody.receipt_ref === null ||
      resource.custody.binding_generation !== resource.binding_generation ||
      resource.custody.checked_at === null
    ) {
      addReadyInvariant(
        errors,
        resourceIndex,
        "custody.receipt_ref",
        "READY requires a custody receipt.",
      );
    }
    validateReadyTimestamp(
      errors,
      resourceIndex,
      "custody.checked_at",
      resource.custody.checked_at,
      nowTime,
    );

    resource.configuration.forEach((configuration, configIndex) => {
      if (!["PASS", "NOT_REQUIRED"].includes(configuration.state)) {
        addReadyInvariant(
          errors,
          resourceIndex,
          `configuration.${configIndex}.state`,
          "READY requires every configuration authority to be PASS or NOT_REQUIRED.",
        );
      }
      if (
        configuration.state === "PASS" &&
        (configuration.checked_at === null ||
          configuration.receipt_ref === null ||
          configuration.canonical_names.length === 0)
      ) {
        addReadyInvariant(
          errors,
          resourceIndex,
          `configuration.${configIndex}`,
          "READY PASS configuration requires names-only bindings, a date, and a receipt.",
        );
      }
      validateReadyTimestamp(
        errors,
        resourceIndex,
        `configuration.${configIndex}.checked_at`,
        configuration.checked_at,
        nowTime,
      );
    });

    if (resource.permissions.required_capabilities.length === 0) {
      addReadyInvariant(
        errors,
        resourceIndex,
        "permissions.required_capabilities",
        "READY requires an explicit non-empty capability baseline.",
      );
    }
    for (const field of ["observed_state", "least_privilege_state"]) {
      if (!["PASS", "NOT_REQUIRED"].includes(resource.permissions[field])) {
        addReadyInvariant(
          errors,
          resourceIndex,
          `permissions.${field}`,
          `READY requires permissions ${field} to be PASS or NOT_REQUIRED.`,
        );
      }
    }
    if (
      resource.permissions.checked_at === null ||
      resource.permissions.receipt_ref === null
    ) {
      addReadyInvariant(
        errors,
        resourceIndex,
        "permissions",
        "READY requires dated permissions and least-privilege evidence.",
      );
    }
    validateReadyTimestamp(
      errors,
      resourceIndex,
      "permissions.checked_at",
      resource.permissions.checked_at,
      nowTime,
    );

    for (const field of [
      "provider_object",
      "credentials",
      "data",
      "runtime",
      "production_separation",
    ]) {
      if (!["PASS", "NOT_REQUIRED"].includes(resource.isolation[field])) {
        addReadyInvariant(
          errors,
          resourceIndex,
          `isolation.${field}`,
          `READY requires isolation ${field} to be PASS or NOT_REQUIRED.`,
        );
      }
    }
    if (resource.isolation.production_separation !== "PASS") {
      addReadyInvariant(
        errors,
        resourceIndex,
        "isolation.production_separation",
        "READY always requires proven separation from production.",
      );
    }
    if (
      resource.isolation.checked_at === null ||
      resource.isolation.receipt_ref === null
    ) {
      addReadyInvariant(
        errors,
        resourceIndex,
        "isolation",
        "READY requires dated isolation evidence.",
      );
    }
    validateReadyTimestamp(
      errors,
      resourceIndex,
      "isolation.checked_at",
      resource.isolation.checked_at,
      nowTime,
    );

    if (resource.lifecycle.reuse_policy === "UNKNOWN") {
      addReadyInvariant(
        errors,
        resourceIndex,
        "lifecycle.reuse_policy",
        "READY requires an explicit reuse policy.",
      );
    }
    for (const field of [
      "expiry_state",
      "reset_state",
      "renewal_state",
      "rotation_state",
      "revocation_state",
      "cleanup_state",
    ]) {
      if (!["TESTED", "NOT_REQUIRED"].includes(resource.lifecycle[field])) {
        addReadyInvariant(
          errors,
          resourceIndex,
          `lifecycle.${field}`,
          `READY requires lifecycle ${field} to be TESTED or NOT_REQUIRED.`,
        );
      }
    }
    if (
      resource.lifecycle.checked_at === null ||
      resource.lifecycle.receipt_ref === null
    ) {
      addReadyInvariant(
        errors,
        resourceIndex,
        "lifecycle",
        "READY requires dated lifecycle evidence.",
      );
    }
    validateReadyTimestamp(
      errors,
      resourceIndex,
      "lifecycle.checked_at",
      resource.lifecycle.checked_at,
      nowTime,
    );

    for (const evidenceKind of ["provider", "runtime", "smoke"]) {
      const evidence = resource.evidence[evidenceKind];
      if (
        evidence.state !== "PASS" ||
        evidence.receipt_ref === null ||
        evidence.observed_at === null ||
        evidence.valid_until === null ||
        evidence.source_commit === null
      ) {
        addReadyInvariant(
          errors,
          resourceIndex,
          `evidence.${evidenceKind}`,
          `READY requires a complete PASS ${evidenceKind} receipt.`,
        );
        continue;
      }
      const observedTime = Date.parse(evidence.observed_at);
      const validUntilTime = Date.parse(evidence.valid_until);
      const maxAgeMs = EVIDENCE_MAX_AGE_MS[evidenceKind];
      if (validUntilTime <= nowTime) {
        addReadyInvariant(
          errors,
          resourceIndex,
          `evidence.${evidenceKind}.valid_until`,
          `READY ${evidenceKind} evidence is expired.`,
        );
      }
      if (nowTime - observedTime > maxAgeMs) {
        addReadyInvariant(
          errors,
          resourceIndex,
          `evidence.${evidenceKind}.observed_at`,
          `READY ${evidenceKind} evidence is older than its allowed certification window.`,
        );
      }
      if (validUntilTime - observedTime > maxAgeMs) {
        addReadyInvariant(
          errors,
          resourceIndex,
          `evidence.${evidenceKind}.valid_until`,
          `READY ${evidenceKind} validity exceeds its maximum allowed lifetime.`,
        );
      }
      if (
        ![
          ledger.snapshot.repository_commit,
          ledger.snapshot.staging_deployment_commit,
        ].includes(evidence.source_commit)
      ) {
        addReadyInvariant(
          errors,
          resourceIndex,
          `evidence.${evidenceKind}.source_commit`,
          `READY ${evidenceKind} evidence must identify a current snapshot commit.`,
        );
      }
    }

    validateReadyTimestamp(
      errors,
      resourceIndex,
      "verdict.evaluated_at",
      resource.verdict.evaluated_at,
      nowTime,
    );

    for (const relation of resource.relations) {
      if (
        !["USES", "DEPENDS_ON", "OWNED_BY", "CONTAINS", "ROUTES_TO"].includes(
          relation.type,
        )
      ) {
        continue;
      }
      const target = resourcesByRef.get(relation.ref);
      if (target?.verdict.state !== "READY") {
        addReadyInvariant(
          errors,
          resourceIndex,
          "relations",
          `READY requires ${relation.type} target ${relation.ref} to be READY.`,
        );
      }
    }

    const stateValues = collectStateValues(resource);
    for (const { path: statePath, state } of stateValues) {
      if (READY_FORBIDDEN_STATES.has(state)) {
        addReadyInvariant(
          errors,
          resourceIndex,
          statePath,
          `READY cannot coexist with state ${state}.`,
        );
      }
    }
  });
}

function collectStateValues(value, pathParts = [], results = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      collectStateValues(item, [...pathParts, String(index)], results);
    });
    return results;
  }
  if (!value || typeof value !== "object") {
    return results;
  }
  for (const [key, child] of Object.entries(value)) {
    const childPath = [...pathParts, key];
    if (
      typeof child === "string" &&
      (key === "state" || key.endsWith("_state"))
    ) {
      results.push({ path: childPath.join("."), state: child });
    } else {
      collectStateValues(child, childPath, results);
    }
  }
  return results;
}

function validateLedgerSemantics(repoRoot, ledger, now) {
  const errors = [];
  const trustedKey = loadTrustedCertificationKey(repoRoot, errors);
  validateCoverage(ledger, errors);
  validateRelations(ledger, errors);
  validateConfiguration(ledger, errors);
  validatePermissions(ledger, errors);
  validateReceiptCoherence(ledger, errors);
  validateReceiptUniqueness(ledger, errors);
  validateVerdicts(ledger, errors);
  validateTimestamps(ledger, errors, now);
  validateDeploymentObservation(ledger, errors);
  validateEvidence(ledger, errors);
  validateReadyResources(ledger, errors, now);
  validateReadyAuthorization(ledger, errors, now, trustedKey);
  return errors;
}

export function serializeStagingResourceLedgerSchema() {
  const jsonSchema = z.toJSONSchema(StagingResourceLedgerSchema, {
    target: "draft-2020-12",
    io: "input",
  });
  jsonSchema.$id =
    "https://github.com/elizaOS/eliza/blob/develop/.github/certification/staging-resources.schema.json";
  return `${JSON.stringify(jsonSchema, null, 2)}\n`;
}

function markdownCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function renderStagingResourceLedgerView(ledger) {
  const displayObservationTime = Math.max(
    Date.parse(ledger.snapshot.observed_at),
    Date.parse(ledger.deployment_observation.observed_at),
  );
  const historicalBanner =
    ledger.deployment_observation.evidence_alignment === "REVALIDATION_REQUIRED"
      ? "> **HISTORICAL — NOT CURRENT:** all observed states, evidence, and verdicts below belong to the evidence snapshot and cannot certify the observed deployment.\n\n"
      : "";
  const rows = [...ledger.resources]
    .sort((left, right) => left.ref.localeCompare(right.ref))
    .map((resource) => {
      const evidence = ["provider", "runtime", "smoke"]
        .map((kind) => {
          const record = resource.evidence[kind];
          const qualifiers = [];
          if (
            ledger.deployment_observation.evidence_alignment ===
              "REVALIDATION_REQUIRED" &&
            !NEUTRAL_EVIDENCE_STATES.has(record.state)
          ) {
            qualifiers.push("HISTORICAL");
          }
          if (
            record.valid_until !== null &&
            Date.parse(record.valid_until) <= displayObservationTime
          ) {
            qualifiers.push("EXPIRED");
          }
          const suffix =
            qualifiers.length > 0 ? `·${qualifiers.join("·")}` : "";
          return `${kind === "provider" ? "P" : kind === "runtime" ? "R" : "S"}:${record.state}${suffix}`;
        })
        .join("<br>");
      const relations =
        resource.relations.length === 0
          ? "—"
          : resource.relations
              .map((relation) => `${relation.type}:${relation.ref}`)
              .join("<br>");
      const custody = [
        `P:${resource.custody.primary_state}`,
        `B:${resource.custody.backup_state}`,
        `R:${resource.custody.recovery_role_state}`,
      ].join("<br>");
      const configuration = resource.configuration
        .map((entry) => `${entry.authority}:${entry.state}`)
        .join("<br>");
      const isolation = [
        `P:${resource.isolation.provider_object}`,
        `C:${resource.isolation.credentials}`,
        `D:${resource.isolation.data}`,
        `R:${resource.isolation.runtime}`,
        `Prod:${resource.isolation.production_separation}`,
      ].join("<br>");
      const lifecycle = [
        `Rs:${resource.lifecycle.reset_state}`,
        `Rn:${resource.lifecycle.renewal_state}`,
        `Ro:${resource.lifecycle.rotation_state}`,
        `Rv:${resource.lifecycle.revocation_state}`,
        `Cl:${resource.lifecycle.cleanup_state}`,
      ].join("<br>");
      const permissions = [
        `Req:${resource.permissions.required_capabilities.join("+")}`,
        `Obs:${resource.permissions.observed_state}`,
        `LP:${resource.permissions.least_privilege_state}`,
      ].join("<br>");
      const historicalVerdict =
        ledger.deployment_observation.evidence_alignment ===
        "REVALIDATION_REQUIRED"
          ? " · HISTORICAL"
          : "";
      const verdict =
        resource.verdict.state === "READY"
          ? "**READY**"
          : `**NOT READY · ${resource.verdict.state}${historicalVerdict}**`;
      const blockers =
        resource.verdict.blocker_issues.length === 0
          ? "—"
          : resource.verdict.blocker_issues
              .map(
                (issue) =>
                  `[#${issue}](https://github.com/elizaOS/eliza/issues/${issue})`,
              )
              .join(", ");
      return `| ${markdownCell(resource.ref)} | ${markdownCell(canonicalCoverageKey(resource.coverage_key))} | ${markdownCell(relations)} | ${markdownCell(resource.private_resolver.state)} | ${markdownCell(`M:${resource.mapping.state}<br>E:${resource.existence.state}`)} | ${markdownCell(custody)} | ${markdownCell(configuration)} | ${markdownCell(permissions)} | ${markdownCell(isolation)} | ${markdownCell(lifecycle)} | ${markdownCell(evidence)} | ${verdict} | ${blockers} |`;
    });

  return `<!-- Generated by ${GENERATED_BY}; do not edit by hand. -->
# Staging resource certification ledger

This public view contains opaque resource references and redacted certification states only. Private owners, provider locators, credentials, recovery material, and conversation data belong in the separately approved private resolver.

${historicalBanner}- Environment: \`${ledger.environment}\`
- Snapshot observed: \`${ledger.snapshot.observed_at}\`
- Repository commit: \`${ledger.snapshot.repository_commit}\`
- Staging deployment commit: \`${ledger.snapshot.staging_deployment_commit}\`
- Deployment observed: \`${ledger.deployment_observation.observed_at}\`
- Current staging deployment commit: \`${ledger.deployment_observation.staging_deployment_commit}\`
- Evidence alignment: \`${ledger.deployment_observation.evidence_alignment}\`
- READY authorization: \`${ledger.ready_authorization === null ? "NONE" : "SIGNED"}\`
- Policy version: \`${ledger.policy_version}\`

Compact labels are controlled states, not readiness scores. **Any verdict prefixed \`NOT READY\` is not certified**, including \`PARTIAL\`. Relations remain opaque public refs. Permissions show required capabilities, observed state, and least privilege. Mapping uses M/E; custody uses primary/backup/recovery; isolation uses provider/credentials/data/runtime/production; lifecycle uses reset/renew/rotate/revoke/cleanup; evidence uses provider/runtime/smoke. \`HISTORICAL\` evidence does not align with the observed deployment, and \`EXPIRED\` evidence is outside its public validity window.

| Ref | Coverage key | Relations | Resolver | Map / exist | Custody P/B/R | Config | Capabilities / permissions | Isolation P/C/D/R/Prod | Lifecycle Rs/Rn/Ro/Rv/Cl | Evidence P/R/S | Verdict | Blockers |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${rows.join("\n")}
`;
}

function validateArtifactDrift(repoRoot, ledger, errors) {
  const loadedSchema = readArtifact(
    repoRoot,
    SCHEMA_PATH,
    "The committed JSON Schema projection is missing.",
  );
  if (loadedSchema.error) {
    errors.push(loadedSchema.error);
  } else {
    const schemaRaw = loadedSchema.raw;
    try {
      JSON.parse(schemaRaw);
    } catch {
      // error-policy:J3 Invalid generated JSON is reported without fallback.
      addError(
        errors,
        "invalid-schema-json",
        SCHEMA_PATH,
        "The committed staging-resource JSON Schema is invalid JSON.",
      );
    }
    if (schemaRaw !== serializeStagingResourceLedgerSchema()) {
      addError(
        errors,
        "schema-drift",
        SCHEMA_PATH,
        `The committed JSON Schema differs from ${GENERATED_BY}; regenerate it with --write-schema.`,
      );
    }
  }

  const loadedView = readArtifact(
    repoRoot,
    VIEW_PATH,
    "The generated public Markdown view is missing.",
  );
  if (loadedView.error) {
    errors.push(loadedView.error);
  } else if (
    ledger &&
    loadedView.raw !== renderStagingResourceLedgerView(ledger)
  ) {
    addError(
      errors,
      "view-drift",
      VIEW_PATH,
      `The public Markdown view differs from ${LEDGER_PATH}; regenerate it with --write-view.`,
    );
  }
}

function normalizeNow(now) {
  const normalized =
    now instanceof Date ? new Date(now.getTime()) : new Date(now);
  if (Number.isNaN(normalized.getTime())) {
    throw new TypeError("now must be a valid date");
  }
  return normalized;
}

function prepareArtifactWrite(repoRoot, relativePath) {
  const resolvedRoot = path.resolve(repoRoot);
  let resolvedPath;
  try {
    resolvedPath = artifactPath(resolvedRoot, relativePath);
  } catch {
    // error-policy:J3 Refuse an output path that cannot be contained.
    return { ok: false, path: null };
  }

  let rootStats;
  try {
    rootStats = fs.lstatSync(resolvedRoot);
  } catch {
    // error-policy:J3 An unreadable repository root is not writable safely.
    return { ok: false, path: resolvedPath };
  }
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    return { ok: false, path: resolvedPath };
  }

  const segments = path
    .relative(resolvedRoot, resolvedPath)
    .split(path.sep)
    .filter(Boolean);
  let current = resolvedRoot;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    let stats;
    try {
      stats = fs.lstatSync(current);
    } catch (error) {
      // error-policy:J3 Create only genuinely absent contained directories.
      if (error?.code !== "ENOENT") return { ok: false, path: resolvedPath };
      try {
        fs.mkdirSync(current);
        stats = fs.lstatSync(current);
      } catch {
        // error-policy:J1 Translate directory creation failure into refusal.
        return { ok: false, path: resolvedPath };
      }
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      return { ok: false, path: resolvedPath };
    }
  }

  try {
    const targetStats = fs.lstatSync(resolvedPath);
    if (targetStats.isSymbolicLink() || !targetStats.isFile()) {
      return { ok: false, path: resolvedPath };
    }
  } catch (error) {
    // error-policy:J3 Only ENOENT is an acceptable new output target.
    if (error?.code !== "ENOENT") return { ok: false, path: resolvedPath };
  }
  return { ok: true, path: resolvedPath };
}

function writeArtifactsAtomically(
  repoRoot,
  outputs,
  { publishRename = fs.renameSync } = {},
) {
  const prepared = [];
  for (const output of outputs) {
    const target = prepareArtifactWrite(repoRoot, output.relativePath);
    if (!target.ok || !target.path) {
      return {
        ok: false,
        errors: [
          {
            type: "unsafe-artifact",
            path: output.relativePath,
            message:
              "Generated artifacts must remain contained regular files with no symbolic-link path components.",
          },
        ],
      };
    }
    prepared.push({ ...output, path: target.path });
  }

  const staged = [];
  const backups = [];
  const published = [];
  let failedPath = outputs[0]?.relativePath ?? "$";
  try {
    for (const output of prepared) {
      failedPath = output.relativePath;
      const temporaryPath = path.join(
        path.dirname(output.path),
        `.${path.basename(output.path)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
      );
      fs.writeFileSync(temporaryPath, output.contents, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o644,
      });
      staged.push({ ...output, temporaryPath });
    }
    for (const output of staged) {
      failedPath = output.relativePath;
      let hadOriginal = false;
      try {
        hadOriginal = fs.lstatSync(output.path).isFile();
      } catch (error) {
        // error-policy:J3 Only an absent generated target can omit a backup.
        if (error?.code !== "ENOENT") throw error;
      }
      let backupPath = null;
      if (hadOriginal) {
        backupPath = path.join(
          path.dirname(output.path),
          `.${path.basename(output.path)}.${process.pid}.${randomBytes(8).toString("hex")}.bak`,
        );
        fs.copyFileSync(output.path, backupPath, fs.constants.COPYFILE_EXCL);
      }
      backups.push({ ...output, hadOriginal, backupPath });
    }
    for (const output of staged) {
      failedPath = output.relativePath;
      const backup = backups.find(
        (entry) => entry.relativePath === output.relativePath,
      );
      publishRename(output.temporaryPath, output.path);
      published.push(backup);
    }
    for (const backup of backups) {
      if (backup.backupPath !== null) {
        try {
          fs.unlinkSync(backup.backupPath);
          backup.backupPath = null;
        } catch {
          // error-policy:J6 Publication is complete; stale backup cleanup is best-effort.
        }
      }
    }
  } catch {
    // error-policy:J1 Restore every previously published target before reporting failure.
    const retainedRecoveryBackups = new Set();
    for (const output of [...published].reverse()) {
      try {
        if (output.hadOriginal && output.backupPath !== null) {
          fs.renameSync(output.backupPath, output.path);
          output.backupPath = null;
        } else {
          fs.unlinkSync(output.path);
        }
      } catch {
        // error-policy:J6 Best-effort rollback continues for the other generated targets.
        if (output.backupPath !== null) {
          retainedRecoveryBackups.add(output.backupPath);
        }
      }
    }
    for (const output of staged) {
      try {
        if (fs.lstatSync(output.temporaryPath).isFile()) {
          fs.unlinkSync(output.temporaryPath);
        }
      } catch {
        // error-policy:J6 Best-effort cleanup of an unpublished temporary artifact.
      }
    }
    for (const backup of backups) {
      if (
        backup.backupPath === null ||
        retainedRecoveryBackups.has(backup.backupPath)
      ) {
        continue;
      }
      try {
        if (fs.lstatSync(backup.backupPath).isFile()) {
          fs.unlinkSync(backup.backupPath);
        }
      } catch {
        // error-policy:J6 Best-effort cleanup of a backup no longer needed for rollback.
      }
    }
    const writeErrors = [
      {
        type: "artifact-write-failure",
        path: failedPath,
        message:
          "Generated certification artifacts could not be written atomically.",
      },
    ];
    if (retainedRecoveryBackups.size > 0) {
      writeErrors.push({
        type: "artifact-rollback-failure",
        path: failedPath,
        message:
          "Rollback was incomplete; a contained recovery backup was retained for manual restoration.",
      });
    }
    return {
      ok: false,
      errors: writeErrors,
    };
  }
  return { ok: true, errors: [] };
}

export function checkStagingResourceLedger({
  repoRoot = defaultRepoRoot,
  now = new Date(),
} = {}) {
  const resolvedRoot = path.resolve(repoRoot);
  const normalizedNow = normalizeNow(now);
  const loaded = parseLedger(resolvedRoot);
  const errors = [...loaded.errors];
  if (loaded.ledger) {
    errors.push(
      ...validateLedgerSemantics(resolvedRoot, loaded.ledger, normalizedNow),
    );
  }
  validateArtifactDrift(resolvedRoot, loaded.ledger, errors);

  return {
    ok: errors.length === 0,
    checked: [
      LEDGER_PATH,
      SCHEMA_PATH,
      VIEW_PATH,
      CERTIFICATION_PUBLIC_KEY_PATH,
    ],
    resourceCount: loaded.ledger?.resources.length ?? 0,
    readyCount:
      loaded.ledger?.resources.filter(
        (resource) => resource.verdict.state === "READY",
      ).length ?? 0,
    errors,
    ledger: loaded.ledger,
  };
}

export function writeStagingResourceLedgerArtifacts({
  repoRoot = defaultRepoRoot,
  writeSchema = false,
  writeView = false,
  now = new Date(),
  fileOperations = undefined,
} = {}) {
  const resolvedRoot = path.resolve(repoRoot);
  if (!writeSchema && !writeView) {
    return { ok: true, written: [], errors: [] };
  }

  const normalizedNow = normalizeNow(now);
  const loaded = parseLedger(resolvedRoot);
  const errors = [...loaded.errors];
  if (loaded.ledger) {
    errors.push(
      ...validateLedgerSemantics(resolvedRoot, loaded.ledger, normalizedNow),
    );
  }
  if (!loaded.ledger || errors.length > 0) {
    return { ok: false, written: [], errors };
  }

  const outputs = [];
  if (writeSchema) {
    outputs.push({
      relativePath: SCHEMA_PATH,
      contents: serializeStagingResourceLedgerSchema(),
    });
  }
  if (writeView) {
    outputs.push({
      relativePath: VIEW_PATH,
      contents: renderStagingResourceLedgerView(loaded.ledger),
    });
  }
  const writeResult = writeArtifactsAtomically(
    resolvedRoot,
    outputs,
    fileOperations,
  );
  return {
    ok: writeResult.ok,
    written: writeResult.ok ? outputs.map((output) => output.relativePath) : [],
    errors: writeResult.errors,
  };
}

export function prepareReadyAuthorizationPayload({
  repoRoot = defaultRepoRoot,
  signedAt,
  validUntil,
  now = new Date(),
} = {}) {
  const resolvedRoot = path.resolve(repoRoot);
  const normalizedNow = normalizeNow(now);
  const loaded = parseLedger(resolvedRoot);
  if (!loaded.ledger || loaded.errors.length > 0) {
    throw new Error(
      "The public ledger must pass structural and privacy validation before a signing payload can be produced.",
    );
  }
  const keyErrors = [];
  if (!loadTrustedCertificationKey(resolvedRoot, keyErrors)) {
    throw new Error(
      "The anchored certification public key must validate before a signing payload can be produced.",
    );
  }
  if (loaded.ledger.ready_authorization !== null) {
    throw new Error(
      "Set ready_authorization to null before preparing a replacement signing payload.",
    );
  }
  if (
    !loaded.ledger.resources.some(
      (resource) => resource.verdict.state === "READY",
    )
  ) {
    throw new Error(
      "A READY authorization payload requires at least one structurally valid READY row.",
    );
  }
  if (
    loaded.ledger.deployment_observation.evidence_alignment !== "ALIGNED" ||
    loaded.ledger.deployment_observation.staging_deployment_commit !==
      loaded.ledger.snapshot.staging_deployment_commit
  ) {
    throw new Error(
      "The observed staging deployment must align with the evidence snapshot before signing.",
    );
  }
  const metadata = readyAuthorizationMetadata({
    payload_version: 1,
    algorithm: "Ed25519",
    key_fingerprint: TRUSTED_CERTIFICATION_KEY_FINGERPRINT,
    signed_at: signedAt,
    valid_until: validUntil,
  });
  const signedAtTime = Date.parse(metadata.signed_at);
  const validUntilTime = Date.parse(metadata.valid_until);
  const latestObservation = Math.max(
    Date.parse(loaded.ledger.snapshot.observed_at),
    Date.parse(loaded.ledger.deployment_observation.observed_at),
  );
  if (
    signedAtTime < latestObservation ||
    signedAtTime > normalizedNow.getTime() ||
    normalizedNow.getTime() - signedAtTime > READY_AUTHORIZATION_MAX_AGE_MS ||
    validUntilTime <= signedAtTime ||
    validUntilTime <= normalizedNow.getTime() ||
    validUntilTime - signedAtTime > READY_AUTHORIZATION_MAX_AGE_MS
  ) {
    throw new Error(
      "Signing times must follow both observations and define a positive validity window no longer than 24 hours.",
    );
  }
  const built = buildReadyAuthorizationPayload(loaded.ledger, metadata);
  return {
    authorization_metadata: {
      ...metadata,
      payload_sha256: built.payloadSha256,
    },
    payload_utf8: built.canonicalJson,
    payload_base64: Buffer.from(built.canonicalJson, "utf8").toString("base64"),
  };
}

function parseArgs(argv) {
  const options = {
    repoRoot: defaultRepoRoot,
    json: false,
    writeSchema: false,
    writeView: false,
    printReadyAuthorizationPayload: false,
    signedAt: null,
    validUntil: null,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repo-root") {
      const value = argv[++index];
      if (!value) throw new Error("--repo-root requires a path");
      options.repoRoot = path.resolve(value);
    } else if (arg.startsWith("--repo-root=")) {
      options.repoRoot = path.resolve(arg.slice("--repo-root=".length));
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--write-schema") {
      options.writeSchema = true;
    } else if (arg === "--write-view") {
      options.writeView = true;
    } else if (arg === "--print-ready-authorization-payload") {
      options.printReadyAuthorizationPayload = true;
    } else if (arg === "--signed-at") {
      const value = argv[++index];
      if (!value) throw new Error("--signed-at requires an ISO timestamp");
      options.signedAt = value;
    } else if (arg.startsWith("--signed-at=")) {
      options.signedAt = arg.slice("--signed-at=".length);
    } else if (arg === "--valid-until") {
      const value = argv[++index];
      if (!value) throw new Error("--valid-until requires an ISO timestamp");
      options.validUntil = value;
    } else if (arg.startsWith("--valid-until=")) {
      options.validUntil = arg.slice("--valid-until=".length);
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function usage() {
  return `Usage: node ${GENERATED_BY} [--repo-root <path>] [--json] [--write-schema] [--write-view]
       node ${GENERATED_BY} --print-ready-authorization-payload --signed-at <ISO> --valid-until <ISO> [--repo-root <path>]

Without write flags, validates the authoritative ledger, its generated JSON
Schema, its redacted Markdown view, coverage, privacy, evidence, and READY
invariants. Write flags regenerate only the named derived artifacts before the
same fail-closed validation runs. The payload mode emits the exact newline-free
UTF-8 canonical JSON and SHA-256 digest for an external Ed25519 signer; it never
resolves or prints private staging data.
`;
}

function reportHuman(result, written) {
  if (written.length > 0) {
    console.log(`[staging-resource-ledger] wrote ${written.join(", ")}`);
  }
  console.log(
    `[staging-resource-ledger] resources=${result.resourceCount} ready=${result.readyCount} errors=${result.errors.length}`,
  );
  for (const error of result.errors) {
    console.error(
      `[staging-resource-ledger] ${error.type} ${error.path}: ${error.message}`,
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
      process.exit(0);
    }
    const commandNow = new Date();
    if (options.printReadyAuthorizationPayload) {
      if (
        options.writeSchema ||
        options.writeView ||
        options.json ||
        options.signedAt === null ||
        options.validUntil === null
      ) {
        throw new Error(
          "Payload mode requires --signed-at and --valid-until and cannot be combined with write or JSON-report flags.",
        );
      }
      const signingPayload = prepareReadyAuthorizationPayload({
        repoRoot: options.repoRoot,
        signedAt: options.signedAt,
        validUntil: options.validUntil,
        now: commandNow,
      });
      console.log(JSON.stringify(signingPayload, null, 2));
      process.exit(0);
    }
    if (options.signedAt !== null || options.validUntil !== null) {
      throw new Error(
        "--signed-at and --valid-until require --print-ready-authorization-payload.",
      );
    }
    const writeResult = writeStagingResourceLedgerArtifacts({
      repoRoot: options.repoRoot,
      writeSchema: options.writeSchema,
      writeView: options.writeView,
      now: commandNow,
    });
    const result = checkStagingResourceLedger({
      repoRoot: options.repoRoot,
      now: commandNow,
    });
    if (!writeResult.ok) {
      result.ok = false;
      result.errors.unshift(...writeResult.errors);
    }
    if (options.json) {
      console.log(
        JSON.stringify(
          {
            ok: result.ok,
            checked: result.checked,
            written: writeResult.written,
            resourceCount: result.resourceCount,
            readyCount: result.readyCount,
            errors: result.errors,
          },
          null,
          2,
        ),
      );
    } else {
      reportHuman(result, writeResult.written);
    }
    process.exit(result.ok ? 0 : 1);
  } catch (error) {
    // error-policy:J1 The CLI boundary prints one sanitized failure and exits.
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[staging-resource-ledger] ${message}`);
    process.exit(1);
  }
}
