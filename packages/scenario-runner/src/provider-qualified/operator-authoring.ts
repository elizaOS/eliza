/**
 * Authors and preflights private provider-canary operator material without
 * contacting a provider or accepting private signing keys. Starter files are
 * deliberately invalid until every operator placeholder is replaced.
 */

import {
  createHash,
  createPublicKey,
  type KeyObject,
  randomBytes,
  verify as verifySignature,
} from "node:crypto";
import { constants, type Dirent, type Stats } from "node:fs";
import {
  type FileHandle,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import type { ScenarioDefinition } from "@elizaos/scenario-runner/schema";
import { loadScenarioMetadataFile } from "../loader.ts";
import {
  PROVIDER_CANARY_SCENARIO_IDS,
  type ProviderCanaryScenarioId,
} from "./canary-catalog.ts";
import { providerCanaryControllerContract } from "./controller-registry.ts";
import {
  EXTERNAL_PROVIDER_CANARY_CONFIG_SCHEMA,
  type ExternalProviderCanaryConfig,
  parseExternalProviderCanaryConfig,
  validateProtectedOperatorStateDirectory,
} from "./external-canary-cli.ts";
import {
  type CanonicalJsonValue,
  canonicalJson,
  canonicalJsonValue,
  createProviderQualificationManifest,
  type ProviderQualificationManifest,
  type ProviderRunBindings,
} from "./manifest.ts";
import {
  createProviderOperationBinding,
  PROVIDER_OPERATION_CONTRACT_BY_KIND,
  PROVIDER_OPERATION_KINDS,
  type ProviderOperationInputByKind,
  type ProviderOperationKind,
  type ProviderOperationRawBinding,
  type ProviderOperationTargetByKind,
} from "./operation-binding.ts";
import {
  createProviderFailureProbeHashBinding,
  type ProviderCanaryAuthorization,
  preflightAuthorizedProviderCanary,
} from "./operator-authorization.ts";
import {
  providerManifestSigningBytes,
  providerObserverKeyId,
} from "./qualification.ts";
import {
  createProviderCanaryScenarioSnapshot,
  parseProviderCanaryScenarioSnapshot,
} from "./scenario-snapshot.ts";

export const PROVIDER_MANIFEST_SIGNING_REQUEST_SCHEMA =
  "eliza.provider-canary-manifest-signing-request.v1" as const;

export const PROVIDER_OPERATOR_TARGET_SCHEMA =
  "eliza.provider-canary-operator-target.v1" as const;
export const PROVIDER_OPERATOR_INPUT_SCHEMA =
  "eliza.provider-canary-operator-input.v1" as const;
export const PROVIDER_OPERATOR_PROBES_SCHEMA =
  "eliza.provider-canary-operator-probes.v1" as const;
export const PROVIDER_OPERATOR_PLAN_SCHEMA =
  "eliza.provider-canary-operator-plan.v3" as const;

export interface ProviderOperatorTargetDocument<
  Kind extends ProviderOperationKind = ProviderOperationKind,
> {
  schema: typeof PROVIDER_OPERATOR_TARGET_SCHEMA;
  scenarioId: ProviderCanaryScenarioId;
  kind: Kind;
  providerTarget: ProviderOperationTargetByKind[Kind];
}

export interface ProviderOperatorInputDocument<
  Kind extends ProviderOperationKind = ProviderOperationKind,
> {
  schema: typeof PROVIDER_OPERATOR_INPUT_SCHEMA;
  scenarioId: ProviderCanaryScenarioId;
  kind: Kind;
  operationInput: ProviderOperationInputByKind[Kind];
}

export interface ProviderOperatorProbeMaterial {
  probeId: string;
  requestPayload: CanonicalJsonValue;
  expectedErrorCode: CanonicalJsonValue;
  scope: CanonicalJsonValue;
  authorizationGrant: CanonicalJsonValue;
}

export interface ProviderOperatorProbesDocument {
  schema: typeof PROVIDER_OPERATOR_PROBES_SCHEMA;
  scenarioId: ProviderCanaryScenarioId;
  probes: readonly [
    ProviderOperatorProbeMaterial,
    ProviderOperatorProbeMaterial,
  ];
}

export interface ProviderOperatorPlanDocument {
  schema: typeof PROVIDER_OPERATOR_PLAN_SCHEMA;
  scenarioId: ProviderCanaryScenarioId;
  operationKind: ProviderOperationKind;
  targetFile: "target.json";
  inputFile: "input.json";
  probesFile: "probes.json";
  bindingsFile: "bindings.json";
  scenarioDefinitionFile: "scenario.json";
  scenarioDirectory: string;
  authorization: {
    manifestAuthorityKeyId: string;
    signerProvider: string;
  };
  execution: {
    authorizationFile: string;
    manifestAuthorityPublicKeyFiles: [string, ...string[]];
    observerPublicKeyFiles: [string, ...string[]];
    deploymentAttestationIssuerPublicKeyFiles: [string, ...string[]];
    semanticJudgePublicKeyFiles: [string, ...string[]];
    releaseTrustPolicyFile: string;
    operatorModuleFile: string;
    operatorModuleSha256: string;
    operatorStateDir: string;
    outputDir: string;
  };
}

export interface ProviderManifestSigningRequest {
  schema: typeof PROVIDER_MANIFEST_SIGNING_REQUEST_SCHEMA;
  scenarioId: ProviderCanaryScenarioId;
  operationKind: ProviderOperationKind;
  signerProvider: string;
  keyId: string;
  manifestSha256: string;
  signingBytesSha256: string;
  signingBytesBase64url: string;
}

export interface ProviderManifestSigner {
  /** Deployment-pinned lowercase SHA-256 ID for the HSM/offline public key. */
  readonly keyId: string;
  /** Public SPKI PEM used locally to verify the HSM/offline response. */
  readonly publicKeyPem: string;
  /** Sign exact manifest bytes inside the signer boundary. */
  signManifest(bytes: Uint8Array): Promise<Uint8Array>;
}

export interface ProviderOperatorPreflightResult {
  status: "operator-material-preflight-passed";
  scenarioId: ProviderCanaryScenarioId;
  operation: ProviderOperationRawBinding;
  probeBindings: ReturnType<typeof createProviderFailureProbeHashBinding>[];
  scenario: ScenarioDefinition;
  bindings: ProviderRunBindings;
  manifestAuthorityKeyId: string;
  signerProvider: string;
  inventory: readonly ProviderCanaryInventorySnapshot[];
}

export interface ProviderCanaryInventorySnapshot {
  scenarioId: ProviderCanaryScenarioId;
  filename: `${ProviderCanaryScenarioId}.scenario.ts`;
  operationKind: ProviderOperationKind;
  lane: "live-only";
  executionProfile: "provider-qualified";
  evidenceScope: "provider-certification";
}

const PLACEHOLDER_PREFIX = "__REPLACE_WITH_";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const p = (name: string): string => `${PLACEHOLDER_PREFIX}${name}__`;

type JsonSchema = Readonly<Record<string, unknown>>;
function schemaForTemplate(value: unknown): Record<string, unknown> {
  if (value === null || typeof value === "boolean") return { const: value };
  if (typeof value === "number") return { type: "integer", minimum: 1 };
  if (typeof value === "string") {
    return value.startsWith(PLACEHOLDER_PREFIX)
      ? {
          type: "string",
          minLength: 1,
          not: { pattern: `^${PLACEHOLDER_PREFIX}` },
        }
      : { const: value };
  }
  if (Array.isArray(value)) {
    return value.length === 0
      ? { type: "array", maxItems: 0 }
      : {
          type: "array",
          minItems: 1,
          items: schemaForTemplate(value[0]),
        };
  }
  const source = value as Record<string, unknown>;
  return {
    type: "object",
    additionalProperties: false,
    required: Object.keys(source),
    properties: Object.fromEntries(
      Object.entries(source).map(([key, child]) => [
        key,
        schemaForTemplate(child),
      ]),
    ),
  };
}

const closedDocumentSchema = (
  schema: string,
  payloadName: string,
): JsonSchema =>
  Object.freeze({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    oneOf: PROVIDER_CANARY_SCENARIO_IDS.map((scenarioId) => {
      const kind = providerCanaryControllerContract(scenarioId).operationKind;
      const payload =
        starterOperation(kind)[
          payloadName === "providerTarget" ? "providerTarget" : "operationInput"
        ];
      return {
        type: "object",
        additionalProperties: false,
        required: ["schema", "scenarioId", "kind", payloadName],
        properties: {
          schema: { const: schema },
          scenarioId: { const: scenarioId },
          kind: { const: kind },
          [payloadName]: schemaForTemplate(payload),
        },
      };
    }),
  });

/** Closed per-operation schemas; runtime preflight additionally enforces native formats and correlations. */
export const PROVIDER_OPERATOR_TARGET_JSON_SCHEMA = closedDocumentSchema(
  PROVIDER_OPERATOR_TARGET_SCHEMA,
  "providerTarget",
);
export const PROVIDER_OPERATOR_INPUT_JSON_SCHEMA = closedDocumentSchema(
  PROVIDER_OPERATOR_INPUT_SCHEMA,
  "operationInput",
);
export const PROVIDER_OPERATOR_PROBES_JSON_SCHEMA = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["schema", "scenarioId", "probes"],
  properties: {
    schema: { const: PROVIDER_OPERATOR_PROBES_SCHEMA },
    scenarioId: { enum: PROVIDER_CANARY_SCENARIO_IDS },
    probes: {
      type: "array",
      minItems: 2,
      maxItems: 2,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "probeId",
          "requestPayload",
          "expectedErrorCode",
          "scope",
          "authorizationGrant",
        ],
        properties: {
          probeId: { type: "string", minLength: 1 },
          requestPayload: true,
          expectedErrorCode: true,
          scope: true,
          authorizationGrant: true,
        },
      },
    },
  },
} as const);
export const PROVIDER_OPERATOR_PLAN_JSON_SCHEMA = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: [
    "schema",
    "scenarioId",
    "operationKind",
    "targetFile",
    "inputFile",
    "probesFile",
    "bindingsFile",
    "scenarioDefinitionFile",
    "scenarioDirectory",
    "authorization",
    "execution",
  ],
  properties: {
    schema: { const: PROVIDER_OPERATOR_PLAN_SCHEMA },
    scenarioId: { enum: PROVIDER_CANARY_SCENARIO_IDS },
    operationKind: { enum: PROVIDER_OPERATION_KINDS },
    targetFile: { const: "target.json" },
    inputFile: { const: "input.json" },
    probesFile: { const: "probes.json" },
    bindingsFile: { const: "bindings.json" },
    scenarioDefinitionFile: { const: "scenario.json" },
    scenarioDirectory: { type: "string", minLength: 1 },
    authorization: {
      type: "object",
      additionalProperties: false,
      required: ["manifestAuthorityKeyId", "signerProvider"],
      properties: {
        manifestAuthorityKeyId: { type: "string", pattern: "^[a-f0-9]{64}$" },
        signerProvider: { type: "string", minLength: 1 },
      },
    },
    execution: {
      type: "object",
      additionalProperties: false,
      required: [
        "authorizationFile",
        "manifestAuthorityPublicKeyFiles",
        "observerPublicKeyFiles",
        "deploymentAttestationIssuerPublicKeyFiles",
        "semanticJudgePublicKeyFiles",
        "releaseTrustPolicyFile",
        "operatorModuleFile",
        "operatorModuleSha256",
        "operatorStateDir",
        "outputDir",
      ],
      properties: {
        authorizationFile: { type: "string", minLength: 1 },
        manifestAuthorityPublicKeyFiles: {
          type: "array",
          minItems: 1,
          maxItems: 16,
          items: { type: "string", minLength: 1 },
        },
        observerPublicKeyFiles: {
          type: "array",
          minItems: 1,
          maxItems: 16,
          items: { type: "string", minLength: 1 },
        },
        deploymentAttestationIssuerPublicKeyFiles: {
          type: "array",
          minItems: 1,
          maxItems: 16,
          items: { type: "string", minLength: 1 },
        },
        semanticJudgePublicKeyFiles: {
          type: "array",
          minItems: 1,
          maxItems: 16,
          items: { type: "string", minLength: 1 },
        },
        releaseTrustPolicyFile: { type: "string", minLength: 1 },
        operatorModuleFile: { type: "string", minLength: 1 },
        operatorModuleSha256: {
          type: "string",
          pattern: "^[a-f0-9]{64}$",
        },
        operatorStateDir: { type: "string", minLength: 1 },
        outputDir: { type: "string", minLength: 1 },
      },
    },
  },
} as const);

function fail(message: string): never {
  throw new Error(`provider-canary operator authoring ${message}`);
}

function record(value: unknown, pathName: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    fail(`${pathName} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  pathName: string,
  keys: readonly string[],
): void {
  const expected = new Set(keys);
  const missing = keys.filter((key) => !Object.hasOwn(value, key));
  const unknown = Object.keys(value).filter((key) => !expected.has(key));
  if (missing.length > 0 || unknown.length > 0) {
    fail(
      `${pathName} violates its closed shape (missing=${missing.join(",") || "none"}; unknown=${unknown.join(",") || "none"})`,
    );
  }
}

function parseScenarioId(
  value: unknown,
  pathName: string,
): ProviderCanaryScenarioId {
  if (
    typeof value !== "string" ||
    !PROVIDER_CANARY_SCENARIO_IDS.includes(value as ProviderCanaryScenarioId)
  ) {
    fail(`${pathName} is not one of the 13 canonical canaries`);
  }
  return value as ProviderCanaryScenarioId;
}

function rejectPlaceholders(value: unknown, pathName: string): void {
  if (typeof value === "string" && value.startsWith(PLACEHOLDER_PREFIX)) {
    fail(`${pathName} still contains a non-runnable operator placeholder`);
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => {
      rejectPlaceholders(child, `${pathName}[${index}]`);
    });
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      rejectPlaceholders(child, `${pathName}.${key}`);
    }
  }
}

function starterOperation(kind: ProviderOperationKind): {
  providerTarget: unknown;
  operationInput: unknown;
} {
  switch (kind) {
    case "bluebubbles.message-send":
      return {
        providerTarget: { chatGuid: p("OPERATOR_OWNED_CHAT_GUID") },
        operationInput: { text: p("HARMLESS_TEXT"), replyToMessageGuid: null },
      };
    case "discord.message-send":
      return {
        providerTarget: {
          guildId: p("OPERATOR_OWNED_GUILD_ID"),
          channelId: p("OPERATOR_OWNED_CHANNEL_ID"),
        },
        operationInput: { text: p("HARMLESS_TEXT"), attachments: [] },
      };
    case "duffel.booking-hold-create":
      return {
        providerTarget: {
          offerId: p("LIVE_TEST_OFFER_ID"),
          itinerary: {
            origin: p("IATA_ORIGIN"),
            destination: p("IATA_DESTINATION"),
            departureDate: p("YYYY_MM_DD"),
            returnDate: null,
            passengerCount: 1,
          },
        },
        operationInput: {
          orderType: "hold",
          totalCents: -1,
          currency: p("ISO_4217_CURRENCY"),
          passengers: [
            {
              offerPassengerId: p("OFFER_PASSENGER_ID"),
              givenName: p("GIVEN_NAME"),
              familyName: p("FAMILY_NAME"),
              bornOn: p("YYYY_MM_DD"),
              email: null,
              phoneNumber: null,
              title: null,
              gender: null,
            },
          ],
          calendarSync: {
            enabled: false,
            calendarId: null,
            title: null,
            description: null,
            location: null,
            timeZone: null,
          },
        },
      };
    case "gmail.email-send":
      return {
        providerTarget: { recipientEmail: p("OPERATOR_OWNED_RECIPIENT_EMAIL") },
        operationInput: {
          subject: p("HARMLESS_SUBJECT"),
          bodyText: p("HARMLESS_BODY"),
          cc: [],
          bcc: [],
        },
      };
    case "google-calendar.event-create":
      return {
        providerTarget: { calendarId: p("OPERATOR_OWNED_CALENDAR_ID") },
        operationInput: {
          title: p("HARMLESS_TITLE"),
          start: p("ISO_DATETIME_START"),
          end: p("ISO_DATETIME_END"),
          timeZone: p("IANA_TIME_ZONE"),
          attendees: [],
          location: null,
          description: null,
          createMeetLink: false,
          sendUpdates: "none",
          recurrence: [],
          idempotencyKey: p("UNIQUE_RUN_IDEMPOTENCY_KEY"),
        },
      };
    case "google-sheets.spreadsheet-create":
      return {
        providerTarget: { parentFolderId: p("OPERATOR_OWNED_FOLDER_ID") },
        operationInput: {
          name: p("HARMLESS_SPREADSHEET_NAME"),
          mimeType: "application/vnd.google-apps.spreadsheet",
          content: null,
        },
      };
    case "signal.message-send":
      return {
        providerTarget: {
          recipientKind: "direct",
          channelId: p("OPERATOR_OWNED_E164"),
        },
        operationInput: { text: p("HARMLESS_TEXT") },
      };
    case "slack.message-send":
      return {
        providerTarget: {
          teamId: p("OPERATOR_OWNED_TEAM_ID"),
          channelId: p("OPERATOR_OWNED_CHANNEL_ID"),
          threadTs: null,
        },
        operationInput: { text: p("HARMLESS_TEXT"), attachments: [] },
      };
    case "telegram.message-send":
      return {
        providerTarget: {
          chatId: p("OPERATOR_OWNED_PRIVATE_CHAT_ID"),
          threadId: null,
        },
        operationInput: { text: p("HARMLESS_TEXT") },
      };
    case "twilio.sms-send":
      return {
        providerTarget: {
          fromE164: p("OPERATOR_OWNED_FROM_E164"),
          toE164: p("OPERATOR_OWNED_TO_E164"),
        },
        operationInput: {
          body: p("HARMLESS_BODY"),
          idempotencyKey: p("UNIQUE_RUN_IDEMPOTENCY_KEY"),
        },
      };
    case "twilio.call-create":
      return {
        providerTarget: {
          fromE164: p("OPERATOR_OWNED_FROM_E164"),
          toE164: p("OPERATOR_OWNED_TO_E164"),
        },
        operationInput: {
          message: p("HARMLESS_MESSAGE"),
          idempotencyKey: p("UNIQUE_RUN_IDEMPOTENCY_KEY"),
        },
      };
    case "whatsapp.message-send":
      return {
        providerTarget: {
          transport: "cloud-api",
          chatId: p("OPERATOR_OWNED_E164"),
        },
        operationInput: {
          text: p("HARMLESS_TEXT"),
          replyToMessageId: null,
          attachments: [],
        },
      };
    case "x.direct-message-send":
      return {
        providerTarget: { participantId: p("OPERATOR_OWNED_PARTICIPANT_ID") },
        operationInput: { text: p("HARMLESS_TEXT") },
      };
  }
}

/** Return a concrete, deliberately non-runnable starter for any canonical canary. */
export function createProviderOperatorStarter(
  scenarioId: ProviderCanaryScenarioId,
  scenarioDirectory: string,
  scenarioDefinition: ScenarioDefinition,
): {
  target: ProviderOperatorTargetDocument;
  input: ProviderOperatorInputDocument;
  probes: ProviderOperatorProbesDocument;
  bindings: ProviderRunBindings;
  plan: ProviderOperatorPlanDocument;
} {
  const kind = providerCanaryControllerContract(scenarioId).operationKind;
  const operation = starterOperation(kind);
  const probe = (failureClass: string): ProviderOperatorProbeMaterial => ({
    probeId: `${scenarioId}:${failureClass}`,
    requestPayload: p(
      `${failureClass.toUpperCase().replaceAll("-", "_")}_REQUEST_PAYLOAD`,
    ),
    expectedErrorCode: p(
      `${failureClass.toUpperCase().replaceAll("-", "_")}_ERROR_CODE`,
    ),
    scope: p(`${failureClass.toUpperCase().replaceAll("-", "_")}_SCOPE`),
    authorizationGrant: p(
      `${failureClass.toUpperCase().replaceAll("-", "_")}_GRANT`,
    ),
  });
  return {
    target: {
      schema: PROVIDER_OPERATOR_TARGET_SCHEMA,
      scenarioId,
      kind,
      providerTarget: operation.providerTarget,
    } as ProviderOperatorTargetDocument,
    input: {
      schema: PROVIDER_OPERATOR_INPUT_SCHEMA,
      scenarioId,
      kind,
      operationInput: operation.operationInput,
    } as ProviderOperatorInputDocument,
    probes: {
      schema: PROVIDER_OPERATOR_PROBES_SCHEMA,
      scenarioId,
      probes: [probe("authorization-denied"), probe("provider-rejected")],
    },
    bindings: createProviderOperatorBindingsStarter({
      scenario: scenarioDefinition,
      operationKind: kind,
    }),
    plan: {
      schema: PROVIDER_OPERATOR_PLAN_SCHEMA,
      scenarioId,
      operationKind: kind,
      targetFile: "target.json",
      inputFile: "input.json",
      probesFile: "probes.json",
      bindingsFile: "bindings.json",
      scenarioDefinitionFile: "scenario.json",
      scenarioDirectory,
      authorization: {
        manifestAuthorityKeyId: p("PINNED_HSM_PUBLIC_KEY_SHA256"),
        signerProvider: p("HSM_OR_OFFLINE_SIGNER_NAME"),
      },
      execution: {
        authorizationFile: p("SIGNED_AUTHORIZATION_JSON_PATH"),
        manifestAuthorityPublicKeyFiles: [
          p("MANIFEST_AUTHORITY_PUBLIC_KEY_PEM_PATH"),
        ],
        observerPublicKeyFiles: [p("OBSERVER_PUBLIC_KEY_PEM_PATH")],
        deploymentAttestationIssuerPublicKeyFiles: [
          p("DEPLOYMENT_ATTESTATION_ISSUER_PUBLIC_KEY_PEM_PATH"),
        ],
        semanticJudgePublicKeyFiles: [p("SEMANTIC_JUDGE_PUBLIC_KEY_PEM_PATH")],
        releaseTrustPolicyFile: p("RELEASE_TRUST_POLICY_JSON_PATH"),
        operatorModuleFile: p("REVIEWED_OPERATOR_MODULE_PATH"),
        operatorModuleSha256: p("REVIEWED_OPERATOR_MODULE_SHA256"),
        operatorStateDir: p("NEW_PRIVATE_OPERATOR_STATE_DIRECTORY"),
        outputDir: p("NEW_PROVIDER_EVIDENCE_OUTPUT_DIRECTORY"),
      },
    },
  };
}

function createProviderOperatorBindingsStarter(input: {
  scenario: ScenarioDefinition;
  operationKind: ProviderOperationKind;
}): ProviderRunBindings {
  const operationContract =
    PROVIDER_OPERATION_CONTRACT_BY_KIND[input.operationKind];
  const trustedChecks = (input.scenario.finalChecks ?? []).filter((check) =>
    [
      "durableApprovalObserved",
      "durableDraftObserved",
      "providerEffectObserved",
      "providerNoEffectObserved",
      "scheduledTaskObserved",
    ].includes(check.type),
  ) as Array<Record<string, unknown>>;
  const connectionRefSha256 = p("CONNECTION_REF_SHA256");
  const environment = p("PROVIDER_ENVIRONMENT");
  const observerKeyId = p("OBSERVER_PUBLIC_KEY_SHA256");
  const hashIdentity = (value: unknown): string =>
    typeof value === "string"
      ? createHash("sha256").update(value, "utf8").digest("hex")
      : p("ACCOUNT_REF_SHA256");
  const observationContracts = trustedChecks.map((check) => {
    const base = {
      contractId: check.name,
      observerId: check.observerId,
      system: check.provider,
      environment,
      connectorProvider:
        check.connectorProvider ?? operationContract.connectorProvider,
      accountRefSha256: hashIdentity(check.accountId),
      connectionRefSha256,
      requiredCount: check.minCount ?? 1,
      maxObservationAgeMs: 60_000,
    };
    if (check.type === "providerEffectObserved") {
      return {
        ...base,
        kind: "provider-effect",
        sourceKind: "provider-api",
        provider: check.provider,
        operation: check.operation,
        providerAcceptanceRequired: true,
        readbackRequired: true,
        idempotencyRequired: true,
      };
    }
    if (check.type === "providerNoEffectObserved") {
      return {
        ...base,
        kind: "provider-no-effect",
        sourceKind: "provider-api",
        provider: check.provider,
        effectKinds: [operationContract.operation],
        scopeSha256: p("NO_EFFECT_SCOPE_SHA256"),
        intervalCoverage:
          check.intervalEndsBeforeReferencedStage === true
            ? "before-referenced-stage"
            : "full-scenario",
        ...(check.trajectoryPhase === undefined
          ? {}
          : { trajectoryPhase: check.trajectoryPhase }),
      };
    }
    const kind =
      check.type === "durableApprovalObserved"
        ? "durable-approval"
        : check.type === "durableDraftObserved"
          ? "durable-draft"
          : "scheduled-task";
    return {
      ...base,
      kind,
      sourceKind: "durable-database",
      state: check.state,
      ...(check.operation === undefined ? {} : { operation: check.operation }),
      ...(check.transitionGroupId === undefined
        ? {}
        : {
            transitionGroupId: check.transitionGroupId,
            transitionIndex: check.transitionIndex,
            trajectoryPhase: check.trajectoryPhase,
          }),
    };
  });
  const targetAccount = observationContracts.find(
    (contract) =>
      contract.kind === "provider-effect" ||
      contract.kind === "provider-no-effect",
  );
  const accountRefSha256 =
    targetAccount?.accountRefSha256 ?? p("ACCOUNT_REF_SHA256");
  const observerIds = [
    ...new Set(
      observationContracts.map((contract) => String(contract.observerId)),
    ),
  ];
  const probe = (
    failureClass: "authorization-denied" | "provider-rejected",
    index: number,
  ) => ({
    probeId: `${input.scenario.id}:${failureClass}`,
    observerId: observerIds[0],
    sourceKind: "provider-api" as const,
    system: operationContract.provider,
    environment,
    provider: operationContract.provider,
    connectorProvider: operationContract.connectorProvider,
    accountRefSha256,
    connectionRefSha256,
    operation: operationContract.operation,
    failureClass,
    requestPayloadSha256: p(`PROBE_${index + 1}_REQUEST_SHA256`),
    expectedStatusCode: failureClass === "authorization-denied" ? 403 : 400,
    expectedErrorCodeSha256: p(`PROBE_${index + 1}_ERROR_SHA256`),
    scopeSha256: p(`PROBE_${index + 1}_SCOPE_SHA256`),
    authorizationGrantSha256: p(`PROBE_${index + 1}_GRANT_SHA256`),
    maxObservationAgeMs: 60_000,
  });
  return {
    runId: p("UNIQUE_RUN_ID"),
    runNonce: p("URL_SAFE_RANDOM_NONCE_AT_LEAST_32_CHARS"),
    repositorySha: p("REPOSITORY_SHA"),
    deploymentSha: p("DEPLOYMENT_SHA"),
    trust: {
      manifestAuthorityKeyId: p("PINNED_HSM_PUBLIC_KEY_SHA256"),
      observerSigners: observerIds.map((observerId) => ({
        observerId,
        keyId: observerKeyId,
      })) as unknown as ProviderRunBindings["trust"]["observerSigners"],
    },
    target: {
      principalRefSha256: p("PRINCIPAL_REF_SHA256"),
      roomRefSha256: p("ROOM_REF_SHA256"),
      operation: {
        schema: "eliza.provider-operation-binding.v1",
        kind: input.operationKind,
        providerTargetRefSha256: p("DERIVED_PROVIDER_TARGET_SHA256"),
        operationInputSha256: p("DERIVED_OPERATION_INPUT_SHA256"),
      },
    },
    models: {
      actingAdapter: p("ACTING_ADAPTER"),
      actingProvider: p("ACTING_PROVIDER"),
      actingModel: p("ACTING_MODEL"),
      judgeProvider: p("INDEPENDENT_JUDGE_PROVIDER"),
      judgeModel: p("INDEPENDENT_JUDGE_MODEL"),
      judgeKeyId: p("SEMANTIC_JUDGE_PUBLIC_KEY_SHA256"),
    },
    connectors: [
      {
        provider: operationContract.connectorProvider,
        accountRefSha256,
        connectionRefSha256,
        environment,
      },
    ],
    ingress: {
      kind: "provider-api",
      provider: operationContract.connectorProvider,
      channel: p("AUTHENTICATED_INGRESS_CHANNEL"),
      accountRefSha256,
      connectionRefSha256,
      authenticatedPrincipalRefSha256: p("PRINCIPAL_REF_SHA256"),
      roomRefSha256: p("ROOM_REF_SHA256"),
      endpointOriginSha256: p("ENDPOINT_ORIGIN_SHA256"),
    },
    capabilities: [
      {
        provider: operationContract.connectorProvider,
        accountRefSha256,
        connectionRefSha256,
        capability: operationContract.operation,
        authorizationGrantSha256: p("CAPABILITY_GRANT_SHA256"),
      },
    ],
    observationContracts:
      observationContracts as unknown as ProviderRunBindings["observationContracts"],
    failureProbes: [
      probe("authorization-denied", 0),
      probe("provider-rejected", 1),
    ],
  };
}

async function writePrivateJson(file: string, value: unknown): Promise<void> {
  const handle = await open(
    file,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writePrivateBytes(
  file: string,
  value: Uint8Array,
): Promise<void> {
  const handle = await open(
    file,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
  try {
    await handle.writeFile(value);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

const CANONICAL_DEFINITION_CATALOG_URL = new URL(
  "../../schema/provider-canary-definitions.json",
  import.meta.url,
);

/** Resolve one full definition from the repository-owned data-only catalog. */
export async function canonicalProviderCanaryDefinition(
  scenarioId: ProviderCanaryScenarioId,
): Promise<ScenarioDefinition> {
  let value: unknown;
  try {
    value = JSON.parse(
      await readFile(CANONICAL_DEFINITION_CATALOG_URL, "utf8"),
    ) as unknown;
  } catch {
    // error-policy:J1 Package-owned catalog failures carry no private data.
    fail("canonical scenario-definition catalog is unreadable or invalid");
  }
  const catalog = record(value, "canonicalDefinitionCatalog");
  exactKeys(catalog, "canonicalDefinitionCatalog", ["schema", "scenarios"]);
  if (catalog.schema !== "eliza.provider-canary-definition-catalog.v1") {
    fail("canonical scenario-definition catalog schema is unsupported");
  }
  if (!Array.isArray(catalog.scenarios) || catalog.scenarios.length !== 13) {
    fail(
      "canonical scenario-definition catalog must contain exactly 13 entries",
    );
  }
  const ids = catalog.scenarios.map(
    (definition, index) =>
      record(definition, `canonicalDefinition[${index}]`).id,
  );
  if (JSON.stringify(ids) !== JSON.stringify(PROVIDER_CANARY_SCENARIO_IDS)) {
    fail("canonical scenario-definition catalog inventory drifted");
  }
  const definitions = catalog.scenarios.map((definition, index) => {
    const id = parseScenarioId(
      record(definition, `canonicalDefinition[${index}]`).id,
      `canonicalDefinition[${index}].id`,
    );
    const operationKind = providerCanaryControllerContract(id).operationKind;
    return parseProviderCanaryScenarioSnapshot({
      bytes: createProviderCanaryScenarioSnapshot({
        definition: definition as ScenarioDefinition,
        operationKind,
      }),
      operationKind,
    });
  });
  const definition = definitions.find(({ id }) => id === scenarioId);
  if (!definition)
    fail(`canonical scenario definition is missing ${scenarioId}`);
  return definition;
}

/** Create a private 0700 authoring directory containing only 0600 JSON files. */
export async function initializeProviderOperatorDirectory(input: {
  directory: string;
  scenarioId: ProviderCanaryScenarioId;
  scenarioDirectory: string;
}): Promise<void> {
  await mkdir(input.directory, { mode: 0o700 });
  const scenarioDefinition = await canonicalProviderCanaryDefinition(
    input.scenarioId,
  );
  const starter = createProviderOperatorStarter(
    input.scenarioId,
    input.scenarioDirectory,
    scenarioDefinition,
  );
  await writePrivateJson(
    path.join(input.directory, "target.json"),
    starter.target,
  );
  await writePrivateJson(
    path.join(input.directory, "input.json"),
    starter.input,
  );
  await writePrivateJson(
    path.join(input.directory, "probes.json"),
    starter.probes,
  );
  await writePrivateJson(
    path.join(input.directory, "bindings.json"),
    starter.bindings,
  );
  await writePrivateBytes(
    path.join(input.directory, "scenario.json"),
    createProviderCanaryScenarioSnapshot({
      definition: scenarioDefinition,
      operationKind: starter.plan.operationKind,
    }),
  );
  await writePrivateJson(path.join(input.directory, "plan.json"), starter.plan);
  await Promise.all([
    chmodExact(input.directory, 0o700),
    ...[
      "target.json",
      "input.json",
      "bindings.json",
      "probes.json",
      "scenario.json",
      "plan.json",
    ].map((file) => chmodExact(path.join(input.directory, file), 0o600)),
  ]);
}

async function chmodExact(file: string, expected: number): Promise<void> {
  let metadata: Stats;
  try {
    metadata = await lstat(file);
  } catch {
    // error-policy:J3 Private material paths become one opaque invalid result.
    fail("operator material is unavailable");
  }
  if (metadata.isSymbolicLink())
    fail("operator material must not use symbolic links");
  if (expected === 0o700 && !metadata.isDirectory()) {
    fail("operator material expected a private directory");
  }
  if (expected === 0o600 && !metadata.isFile()) {
    fail("operator material expected a private regular file");
  }
  const currentUid = process.getuid?.();
  if (currentUid !== undefined && metadata.uid !== currentUid) {
    fail("operator material must be owned by the current POSIX user");
  }
  const actual = metadata.mode & 0o777;
  if (actual !== expected)
    fail(
      `operator material mode must be ${expected.toString(8)}, got ${actual.toString(8)}`,
    );
}

async function readProtectedFile(
  file: string,
  options: { privateMode: boolean; label: string },
): Promise<Buffer> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    const currentUid = process.getuid?.();
    if (
      !metadata.isFile() ||
      (currentUid !== undefined && metadata.uid !== currentUid) ||
      (metadata.mode & 0o022) !== 0 ||
      (options.privateMode && (metadata.mode & 0o077) !== 0) ||
      metadata.size > 16 * 1024 * 1024
    ) {
      fail(`${options.label} is not a protected, bounded regular file`);
    }
    return await handle.readFile();
  } catch {
    // error-policy:J3 Private paths and content become one opaque refusal.
    return fail(`${options.label} is unreadable or invalid`);
  } finally {
    await handle?.close();
  }
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(
      (
        await readProtectedFile(file, {
          privateMode: true,
          label: "a private JSON document",
        })
      ).toString("utf8"),
    ) as unknown;
  } catch {
    // error-policy:J3 Private operator input becomes an opaque invalid result.
    fail("a private JSON document is unreadable or invalid");
  }
}

async function readPrivateBytes(file: string): Promise<Buffer> {
  return readProtectedFile(file, {
    privateMode: true,
    label: "a private scenario snapshot",
  });
}

/** Statically preflight the exact 13-file provider inventory without importing scenarios. */
export async function preflightProviderCanaryInventory(
  scenarioDirectory: string,
): Promise<readonly ProviderCanaryInventorySnapshot[]> {
  const entries: Dirent[] = await readdir(scenarioDirectory, {
    withFileTypes: true,
  });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".scenario.ts"))
    .map((entry) => entry.name)
    .sort();
  const expected = PROVIDER_CANARY_SCENARIO_IDS.map(
    (id) => `${id}.scenario.ts`,
  );
  if (JSON.stringify(files) !== JSON.stringify(expected))
    fail(
      "scenario inventory must contain exactly the 13 canonical canary files",
    );
  const snapshots = await Promise.all(
    files.map(async (filename) => {
      const metadata = await loadScenarioMetadataFile(
        path.join(scenarioDirectory, filename),
      );
      const scenarioId = parseScenarioId(metadata.id, `${filename}.id`);
      if (
        metadata.lane !== "live-only" ||
        metadata.executionProfile !== "provider-qualified" ||
        metadata.evidenceScope !== "provider-certification"
      ) {
        fail(
          `${filename} is not a live-only/provider-qualified/provider-certification scenario`,
        );
      }
      return {
        scenarioId,
        filename: filename as `${ProviderCanaryScenarioId}.scenario.ts`,
        operationKind:
          providerCanaryControllerContract(scenarioId).operationKind,
        lane: metadata.lane,
        executionProfile: metadata.executionProfile,
        evidenceScope: metadata.evidenceScope,
      };
    }),
  );
  return Object.freeze(snapshots);
}

/** Validate private authoring material and the complete data-only catalog. Never executes ingress. */
export async function preflightProviderOperatorDirectory(
  directory: string,
): Promise<ProviderOperatorPreflightResult> {
  await chmodExact(directory, 0o700);
  const names = (await readdir(directory)).sort();
  const expectedNames = [
    "bindings.json",
    "input.json",
    "plan.json",
    "probes.json",
    "scenario.json",
    "target.json",
  ];
  if (JSON.stringify(names) !== JSON.stringify(expectedNames))
    fail(
      "operator directory must contain exactly bindings.json, input.json, plan.json, probes.json, scenario.json, and target.json",
    );
  await Promise.all(
    names.map((name) => chmodExact(path.join(directory, name), 0o600)),
  );
  const [
    targetValue,
    inputValue,
    probesValue,
    bindingsValue,
    planValue,
    scenarioBytes,
  ] = await Promise.all([
    readJson(path.join(directory, "target.json")),
    readJson(path.join(directory, "input.json")),
    readJson(path.join(directory, "probes.json")),
    readJson(path.join(directory, "bindings.json")),
    readJson(path.join(directory, "plan.json")),
    readPrivateBytes(path.join(directory, "scenario.json")),
  ]);
  for (const [name, value] of [
    ["target", targetValue],
    ["input", inputValue],
    ["probes", probesValue],
    ["bindings", bindingsValue],
    ["plan", planValue],
  ] as const)
    rejectPlaceholders(value, name);
  const target = record(targetValue, "target");
  exactKeys(target, "target", [
    "schema",
    "scenarioId",
    "kind",
    "providerTarget",
  ]);
  const operationInput = record(inputValue, "input");
  exactKeys(operationInput, "input", [
    "schema",
    "scenarioId",
    "kind",
    "operationInput",
  ]);
  const probes = record(probesValue, "probes");
  exactKeys(probes, "probes", ["schema", "scenarioId", "probes"]);
  const plan = record(planValue, "plan");
  exactKeys(plan, "plan", [
    "schema",
    "scenarioId",
    "operationKind",
    "targetFile",
    "inputFile",
    "probesFile",
    "bindingsFile",
    "scenarioDefinitionFile",
    "scenarioDirectory",
    "authorization",
    "execution",
  ]);
  if (
    target.schema !== PROVIDER_OPERATOR_TARGET_SCHEMA ||
    operationInput.schema !== PROVIDER_OPERATOR_INPUT_SCHEMA ||
    probes.schema !== PROVIDER_OPERATOR_PROBES_SCHEMA ||
    plan.schema !== PROVIDER_OPERATOR_PLAN_SCHEMA
  )
    fail("one or more document schemas are unsupported");
  const scenarioId = parseScenarioId(plan.scenarioId, "plan.scenarioId");
  for (const document of [target, operationInput, probes])
    if (document.scenarioId !== scenarioId)
      fail("all documents must bind the same scenarioId");
  const expectedKind =
    providerCanaryControllerContract(scenarioId).operationKind;
  if (
    target.kind !== expectedKind ||
    operationInput.kind !== expectedKind ||
    plan.operationKind !== expectedKind
  )
    fail("all documents must bind the canonical operation kind");
  if (
    plan.targetFile !== "target.json" ||
    plan.inputFile !== "input.json" ||
    plan.probesFile !== "probes.json" ||
    plan.bindingsFile !== "bindings.json" ||
    plan.scenarioDefinitionFile !== "scenario.json"
  )
    fail("plan file references are not canonical");
  const authorization = record(plan.authorization, "plan.authorization");
  exactKeys(authorization, "plan.authorization", [
    "manifestAuthorityKeyId",
    "signerProvider",
  ]);
  if (
    typeof authorization.manifestAuthorityKeyId !== "string" ||
    !SHA256_PATTERN.test(authorization.manifestAuthorityKeyId)
  )
    fail(
      "plan.authorization.manifestAuthorityKeyId must be a lowercase SHA-256 digest",
    );
  if (
    typeof authorization.signerProvider !== "string" ||
    authorization.signerProvider.trim().length === 0
  )
    fail("plan.authorization.signerProvider must be non-empty");
  if (
    typeof plan.scenarioDirectory !== "string" ||
    plan.scenarioDirectory.length === 0
  )
    fail("plan.scenarioDirectory must be non-empty");
  const execution = record(plan.execution, "plan.execution");
  exactKeys(execution, "plan.execution", [
    "authorizationFile",
    "manifestAuthorityPublicKeyFiles",
    "observerPublicKeyFiles",
    "deploymentAttestationIssuerPublicKeyFiles",
    "semanticJudgePublicKeyFiles",
    "releaseTrustPolicyFile",
    "operatorModuleFile",
    "operatorModuleSha256",
    "operatorStateDir",
    "outputDir",
  ]);
  parseExternalProviderCanaryConfig({
    schema: EXTERNAL_PROVIDER_CANARY_CONFIG_SCHEMA,
    scenarioDefinitionFile: "scenario.json",
    authorizationFile: execution.authorizationFile,
    operationKind: expectedKind,
    providerTargetFile: "target.json",
    operationInputFile: "input.json",
    failureProbesFile: "probes.json",
    manifestAuthorityPublicKeyFiles: execution.manifestAuthorityPublicKeyFiles,
    observerPublicKeyFiles: execution.observerPublicKeyFiles,
    deploymentAttestationIssuerPublicKeyFiles:
      execution.deploymentAttestationIssuerPublicKeyFiles,
    semanticJudgePublicKeyFiles: execution.semanticJudgePublicKeyFiles,
    releaseTrustPolicyFile: execution.releaseTrustPolicyFile,
    operatorModuleFile: execution.operatorModuleFile,
    operatorModuleSha256: execution.operatorModuleSha256,
    operatorStateDir: execution.operatorStateDir,
    outputDir: execution.outputDir,
  });
  const operation = canonicalJsonValue(
    {
      kind: expectedKind,
      providerTarget: target.providerTarget,
      operationInput: operationInput.operationInput,
    },
    "operation",
  ) as unknown as ProviderOperationRawBinding;
  createProviderOperationBinding(operation);
  const operationBinding = createProviderOperationBinding(operation);
  if (!Array.isArray(probes.probes) || probes.probes.length !== 2)
    fail("probes.probes must contain exactly two probes");
  const probeBindings = probes.probes.map((probe) =>
    createProviderFailureProbeHashBinding(
      probe as ProviderOperatorProbeMaterial,
    ),
  );
  if (new Set(probeBindings.map(({ probeId }) => probeId)).size !== 2)
    fail("probe IDs must be unique");
  const bindings = canonicalJsonValue(
    bindingsValue,
    "bindings",
  ) as unknown as ProviderRunBindings;
  if (
    bindings.trust?.manifestAuthorityKeyId !==
    authorization.manifestAuthorityKeyId
  ) {
    fail("bindings manifest authority does not match plan.authorization");
  }
  if (
    canonicalJson(
      canonicalJsonValue(
        bindings.target?.operation,
        "bindings.target.operation",
      ),
    ) !==
    canonicalJson(canonicalJsonValue(operationBinding, "operationBinding"))
  ) {
    fail("bindings.target.operation does not match target.json and input.json");
  }
  if (!Array.isArray(bindings.failureProbes)) {
    fail("bindings.failureProbes must be an array");
  }
  const probeById = new Map(
    probeBindings.map((probe) => [probe.probeId, probe]),
  );
  for (const contract of bindings.failureProbes) {
    const derived = probeById.get(contract.probeId);
    if (
      !derived ||
      contract.requestPayloadSha256 !== derived.requestPayloadSha256 ||
      contract.expectedErrorCodeSha256 !== derived.expectedErrorCodeSha256 ||
      contract.scopeSha256 !== derived.scopeSha256 ||
      contract.authorizationGrantSha256 !== derived.authorizationGrantSha256
    ) {
      fail("bindings failure probes do not match probes.json");
    }
  }
  if (bindings.failureProbes.length !== probeBindings.length) {
    fail("bindings failure probes must correspond one-to-one with probes.json");
  }
  const inventory = await preflightProviderCanaryInventory(
    path.resolve(directory, plan.scenarioDirectory),
  );
  const parsedScenario = parseProviderCanaryScenarioSnapshot({
    bytes: scenarioBytes,
    operationKind: expectedKind,
  });
  const canonicalScenario = await canonicalProviderCanaryDefinition(scenarioId);
  if (
    !createProviderCanaryScenarioSnapshot({
      definition: parsedScenario,
      operationKind: expectedKind,
    }).equals(
      createProviderCanaryScenarioSnapshot({
        definition: canonicalScenario,
        operationKind: expectedKind,
      }),
    )
  ) {
    fail(
      "scenario.json does not match the repository-owned canonical definition",
    );
  }
  createProviderQualificationManifest({
    scenario: parsedScenario,
    bindings,
  });
  return Object.freeze({
    status: "operator-material-preflight-passed",
    scenarioId,
    operation,
    probeBindings,
    scenario: parsedScenario,
    bindings,
    manifestAuthorityKeyId: authorization.manifestAuthorityKeyId,
    signerProvider: authorization.signerProvider,
    inventory,
  });
}

async function publishPrivateFileAtomically(
  outputFile: string,
  bytes: Uint8Array,
): Promise<void> {
  const absolute = path.resolve(outputFile);
  const parent = path.dirname(absolute);
  let parentMetadata: Stats;
  try {
    parentMetadata = await lstat(parent);
  } catch {
    // error-policy:J3 Publication paths become one opaque invalid result.
    fail("publication parent is unavailable");
  }
  const currentUid = process.getuid?.();
  if (
    parentMetadata.isSymbolicLink() ||
    !parentMetadata.isDirectory() ||
    (currentUid !== undefined && parentMetadata.uid !== currentUid) ||
    (parentMetadata.mode & 0o022) !== 0
  ) {
    fail("publication parent must be an owned, protected real directory");
  }
  const staging = path.join(
    parent,
    `.${path.basename(absolute)}.${randomBytes(16).toString("hex")}.staging`,
  );
  try {
    await writePrivateBytes(staging, bytes);
    await link(staging, absolute);
    await unlink(staging);
    const parentHandle = await open(parent, constants.O_RDONLY);
    try {
      await parentHandle.sync();
    } finally {
      await parentHandle.close();
    }
  } catch (error) {
    try {
      await unlink(staging);
    } catch (cleanupError) {
      // error-policy:J6 Best-effort staging cleanup cannot obscure publication refusal.
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
        // The staging name contains no private material and is deliberately not reported.
      }
    }
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      fail("publication output already exists");
    }
    fail("atomic publication failed");
  }
}

function createSigningRequest(
  preflight: ProviderOperatorPreflightResult,
): ProviderManifestSigningRequest {
  const manifest = createProviderQualificationManifest({
    scenario: preflight.scenario,
    bindings: preflight.bindings,
  });
  const signingBytes = providerManifestSigningBytes(manifest);
  return Object.freeze({
    schema: PROVIDER_MANIFEST_SIGNING_REQUEST_SCHEMA,
    scenarioId: preflight.scenarioId,
    operationKind: preflight.operation.kind,
    signerProvider: preflight.signerProvider,
    keyId: preflight.manifestAuthorityKeyId,
    manifestSha256: manifest.manifestSha256,
    signingBytesSha256: createHash("sha256").update(signingBytes).digest("hex"),
    signingBytesBase64url: signingBytes.toString("base64url"),
  });
}

/** Preflight private material and atomically export exact bytes for an offline signer. */
export async function exportProviderManifestSigningRequest(input: {
  authoringDirectory: string;
  requestFile: string;
}): Promise<ProviderManifestSigningRequest> {
  const request = createSigningRequest(
    await preflightProviderOperatorDirectory(input.authoringDirectory),
  );
  await publishPrivateFileAtomically(
    input.requestFile,
    Buffer.from(
      `${canonicalJson(canonicalJsonValue(request, "signingRequest"))}\n`,
      "utf8",
    ),
  );
  return request;
}

function parseSigningRequest(bytes: Buffer): ProviderManifestSigningRequest {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    // error-policy:J3 Detached signing material becomes an opaque invalid result.
    fail("signing request is unreadable or invalid");
  }
  const request = record(value, "signingRequest");
  exactKeys(request, "signingRequest", [
    "schema",
    "scenarioId",
    "operationKind",
    "signerProvider",
    "keyId",
    "manifestSha256",
    "signingBytesSha256",
    "signingBytesBase64url",
  ]);
  const canonicalBytes = Buffer.from(
    `${canonicalJson(canonicalJsonValue(request, "signingRequest"))}\n`,
    "utf8",
  );
  if (!bytes.equals(canonicalBytes)) fail("signing request is not canonical");
  if (
    request.schema !== PROVIDER_MANIFEST_SIGNING_REQUEST_SCHEMA ||
    typeof request.signerProvider !== "string" ||
    request.signerProvider.length === 0 ||
    typeof request.keyId !== "string" ||
    !SHA256_PATTERN.test(request.keyId) ||
    typeof request.manifestSha256 !== "string" ||
    !SHA256_PATTERN.test(request.manifestSha256) ||
    typeof request.signingBytesSha256 !== "string" ||
    !SHA256_PATTERN.test(request.signingBytesSha256) ||
    typeof request.signingBytesBase64url !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(request.signingBytesBase64url)
  ) {
    fail("signing request metadata is invalid");
  }
  parseScenarioId(request.scenarioId, "signingRequest.scenarioId");
  if (
    !PROVIDER_OPERATION_KINDS.includes(
      request.operationKind as ProviderOperationKind,
    )
  ) {
    fail("signing request operation kind is invalid");
  }
  const signingBytes = Buffer.from(request.signingBytesBase64url, "base64url");
  if (
    signingBytes.toString("base64url") !== request.signingBytesBase64url ||
    createHash("sha256").update(signingBytes).digest("hex") !==
      request.signingBytesSha256
  ) {
    fail("signing request bytes do not match their digest");
  }
  return request as unknown as ProviderManifestSigningRequest;
}

/** Verify a detached offline signature and atomically publish authorization.json. */
export async function importProviderManifestSignature(input: {
  authoringDirectory: string;
  requestFile: string;
  signatureFile: string;
  publicKeyFile: string;
  authorizationFile: string;
}): Promise<ProviderCanaryAuthorization> {
  if (path.basename(input.authorizationFile) !== "authorization.json") {
    fail("authorization output must be named authorization.json");
  }
  const preflight = await preflightProviderOperatorDirectory(
    input.authoringDirectory,
  );
  const expectedRequest = createSigningRequest(preflight);
  const plan = record(
    await readJson(path.join(input.authoringDirectory, "plan.json")),
    "plan",
  );
  const execution = record(plan.execution, "plan.execution");
  if (
    path.resolve(
      input.authoringDirectory,
      String(execution.authorizationFile),
    ) !== path.resolve(input.authorizationFile)
  ) {
    fail(
      "authorization output does not match plan.execution.authorizationFile",
    );
  }
  if (
    !Array.isArray(execution.manifestAuthorityPublicKeyFiles) ||
    !execution.manifestAuthorityPublicKeyFiles.some(
      (candidate) =>
        typeof candidate === "string" &&
        path.resolve(input.authoringDirectory, candidate) ===
          path.resolve(input.publicKeyFile),
    )
  ) {
    fail("pinned public key is not declared by the execution plan");
  }
  const request = parseSigningRequest(
    await readProtectedFile(input.requestFile, {
      privateMode: true,
      label: "signing request",
    }),
  );
  if (
    canonicalJson(canonicalJsonValue(request, "signingRequest")) !==
    canonicalJson(canonicalJsonValue(expectedRequest, "expectedSigningRequest"))
  ) {
    fail("signing request does not match current preflighted material");
  }
  const signature = await readProtectedFile(input.signatureFile, {
    privateMode: true,
    label: "detached signature",
  });
  if (signature.byteLength !== 64) {
    fail("detached signature must contain exactly 64 bytes");
  }
  const publicKeyBytes = await readProtectedFile(input.publicKeyFile, {
    privateMode: false,
    label: "pinned public key",
  });
  let publicKey: KeyObject;
  let publicKeyPem: string;
  try {
    publicKeyPem = publicKeyBytes.toString("utf8");
    publicKey = createPublicKey(publicKeyPem);
  } catch {
    // error-policy:J3 Public-key parser details become an invalid pin result.
    fail("pinned public key is not a valid Ed25519 SPKI PEM");
  }
  if (
    publicKey.asymmetricKeyType !== "ed25519" ||
    providerObserverKeyId(publicKeyPem) !== request.keyId
  ) {
    fail("pinned public key does not match the requested key identity");
  }
  const signingBytes = Buffer.from(request.signingBytesBase64url, "base64url");
  if (!verifySignature(null, signingBytes, publicKey, signature)) {
    fail("detached signature is invalid for the exact signing request");
  }
  const manifest = createProviderQualificationManifest({
    scenario: preflight.scenario,
    bindings: preflight.bindings,
  });
  const authorization: ProviderCanaryAuthorization = Object.freeze({
    schema: "eliza.provider-canary-authorization.v1",
    manifest,
    manifestSignature: Object.freeze({
      keyId: request.keyId,
      manifestSha256: request.manifestSha256,
      signature: signature.toString("base64url"),
    }),
  });
  preflightAuthorizedProviderCanary({
    scenario: preflight.scenario,
    authorization,
    pinnedManifestAuthorityPublicKeysPem: [publicKeyPem],
  });
  await publishPrivateFileAtomically(
    input.authorizationFile,
    Buffer.from(
      `${canonicalJson(canonicalJsonValue(authorization, "authorization"))}\n`,
      "utf8",
    ),
  );
  return authorization;
}

async function readOwnedRegularFile(
  baseDirectory: string,
  candidate: unknown,
  privateMode: boolean,
): Promise<{ bytes: Buffer }> {
  if (typeof candidate !== "string" || candidate.trim().length === 0) {
    fail("run-preparation source path must be non-empty");
  }
  const absolute = path.resolve(baseDirectory, candidate);
  return {
    bytes: await readProtectedFile(absolute, {
      privateMode,
      label: "a run-preparation source",
    }),
  };
}

/**
 * Render the exact v2 executable config and self-contained 0600 inputs into a
 * new 0700 directory. The prepared directory still performs no provider work.
 */
export async function prepareProviderCanaryRunDirectory(input: {
  authoringDirectory: string;
  runDirectory: string;
}): Promise<ExternalProviderCanaryConfig> {
  const finalDirectory = path.resolve(input.runDirectory);
  const parentDirectory = path.dirname(finalDirectory);
  const stagingDirectory = path.join(
    parentDirectory,
    `.${path.basename(finalDirectory)}.staging`,
  );
  const parentMetadata = await lstat(parentDirectory);
  if (parentMetadata.isSymbolicLink() || !parentMetadata.isDirectory()) {
    fail("prepared run parent must be a real directory");
  }
  const currentUid = process.getuid?.();
  if (currentUid !== undefined && parentMetadata.uid !== currentUid) {
    fail("prepared run parent must be owned by the current POSIX user");
  }
  if ((parentMetadata.mode & 0o022) !== 0) {
    fail("prepared run parent must not be group- or world-writable");
  }
  const assertAbsent = async (
    candidate: string,
    label: string,
  ): Promise<void> => {
    try {
      await lstat(candidate);
      fail(`${label} must not already exist`);
    } catch (error) {
      // error-policy:J3 ENOENT is the single valid atomic-publication precondition.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  };
  await assertAbsent(finalDirectory, "prepared run directory");
  await assertAbsent(stagingDirectory, "prepared run staging directory");
  const preflight = await preflightProviderOperatorDirectory(
    input.authoringDirectory,
  );
  const [target, operationInput, probes, planValue, scenarioBytes] =
    await Promise.all([
      readJson(path.join(input.authoringDirectory, "target.json")),
      readJson(path.join(input.authoringDirectory, "input.json")),
      readJson(path.join(input.authoringDirectory, "probes.json")),
      readJson(path.join(input.authoringDirectory, "plan.json")),
      readPrivateBytes(path.join(input.authoringDirectory, "scenario.json")),
    ]);
  const targetDocument = record(target, "target");
  const inputDocument = record(operationInput, "input");
  const probesDocument = record(probes, "probes");
  const plan = record(planValue, "plan");
  const execution = record(plan.execution, "plan.execution");
  const sourceList = async (
    value: unknown,
    prefix: string,
  ): Promise<string[]> => {
    if (!Array.isArray(value) || value.length === 0 || value.length > 16) {
      fail(`${prefix} must contain 1-16 source paths`);
    }
    const names: string[] = [];
    for (const [index, candidate] of value.entries()) {
      const source = await readOwnedRegularFile(
        input.authoringDirectory,
        candidate,
        false,
      );
      const name = `${prefix}-${index}.pem`;
      await writePrivateBytes(path.join(stagingDirectory, name), source.bytes);
      names.push(name);
    }
    return names;
  };

  const authorization = await readOwnedRegularFile(
    input.authoringDirectory,
    execution.authorizationFile,
    true,
  );
  const operatorModule = await readOwnedRegularFile(
    input.authoringDirectory,
    execution.operatorModuleFile,
    false,
  );
  const releaseTrustPolicy = await readOwnedRegularFile(
    input.authoringDirectory,
    execution.releaseTrustPolicyFile,
    false,
  );
  if (
    typeof execution.operatorModuleSha256 !== "string" ||
    createHash("sha256").update(operatorModule.bytes).digest("hex") !==
      execution.operatorModuleSha256
  ) {
    fail("operator module bytes do not match operatorModuleSha256");
  }
  const operatorStateDir = validateProtectedOperatorStateDirectory(
    path.resolve(input.authoringDirectory, String(execution.operatorStateDir)),
  );
  const outputDir = path.resolve(
    input.authoringDirectory,
    String(execution.outputDir),
  );
  const contains = (parent: string, candidate: string): boolean => {
    const relative = path.relative(parent, candidate);
    return (
      relative === "" ||
      (!relative.startsWith("..") && !path.isAbsolute(relative))
    );
  };
  if (
    contains(finalDirectory, operatorStateDir) ||
    contains(stagingDirectory, operatorStateDir) ||
    contains(finalDirectory, outputDir) ||
    contains(stagingDirectory, outputDir)
  ) {
    fail(
      "operatorStateDir and outputDir must be outside the prepared run directory",
    );
  }
  try {
    await lstat(outputDir);
    fail("prepared outputDir must not already exist");
  } catch (error) {
    // error-policy:J3 ENOENT is the single valid output-path precondition.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(stagingDirectory, { mode: 0o700 });
  try {
    await writePrivateBytes(
      path.join(stagingDirectory, "authorization.json"),
      authorization.bytes,
    );
    await writePrivateBytes(
      path.join(stagingDirectory, "operator-module.mjs"),
      operatorModule.bytes,
    );
    await writePrivateBytes(
      path.join(stagingDirectory, "release-trust-policy.json"),
      releaseTrustPolicy.bytes,
    );
    await writePrivateBytes(
      path.join(stagingDirectory, "scenario.json"),
      scenarioBytes,
    );
    await writePrivateJson(
      path.join(stagingDirectory, "target.json"),
      targetDocument.providerTarget,
    );
    await writePrivateJson(
      path.join(stagingDirectory, "input.json"),
      inputDocument.operationInput,
    );
    await writePrivateJson(
      path.join(stagingDirectory, "probes.json"),
      probesDocument.probes,
    );
    const authorityFiles = await sourceList(
      execution.manifestAuthorityPublicKeyFiles,
      "manifest-authority",
    );
    const observerFiles = await sourceList(
      execution.observerPublicKeyFiles,
      "observer",
    );
    const deploymentAttestationIssuerFiles = await sourceList(
      execution.deploymentAttestationIssuerPublicKeyFiles,
      "deployment-attestation-issuer",
    );
    const semanticFiles = await sourceList(
      execution.semanticJudgePublicKeyFiles,
      "semantic-judge",
    );
    const config = parseExternalProviderCanaryConfig({
      schema: EXTERNAL_PROVIDER_CANARY_CONFIG_SCHEMA,
      scenarioDefinitionFile: "scenario.json",
      authorizationFile: "authorization.json",
      operationKind: preflight.operation.kind,
      providerTargetFile: "target.json",
      operationInputFile: "input.json",
      failureProbesFile: "probes.json",
      manifestAuthorityPublicKeyFiles: authorityFiles,
      observerPublicKeyFiles: observerFiles,
      deploymentAttestationIssuerPublicKeyFiles:
        deploymentAttestationIssuerFiles,
      semanticJudgePublicKeyFiles: semanticFiles,
      releaseTrustPolicyFile: "release-trust-policy.json",
      operatorModuleFile: "operator-module.mjs",
      operatorModuleSha256: execution.operatorModuleSha256,
      operatorStateDir,
      outputDir,
    });
    await writePrivateJson(path.join(stagingDirectory, "config.json"), config);
    await chmodExact(stagingDirectory, 0o700);
    await Promise.all(
      (await readdir(stagingDirectory)).map((name) =>
        chmodExact(path.join(stagingDirectory, name), 0o600),
      ),
    );
    const stagingHandle = await open(stagingDirectory, "r");
    try {
      await stagingHandle.sync();
    } finally {
      await stagingHandle.close();
    }
    await rename(stagingDirectory, finalDirectory);
    const parentHandle = await open(parentDirectory, "r");
    try {
      await parentHandle.sync();
    } finally {
      await parentHandle.close();
    }
    return config;
  } catch (error) {
    try {
      await rm(stagingDirectory, { recursive: true, force: true });
    } catch (cleanupError) {
      // error-policy:J2 A failed cleanup is surfaced with the preparation failure.
      throw new Error("failed to remove private run staging after refusal", {
        cause: new AggregateError([error, cleanupError]),
      });
    }
    throw error;
  }
}

/** Authorize via an injected offline/HSM signer; private key bytes never cross this API. */
export async function authorizeProviderCanaryWithSigner(input: {
  scenario: ScenarioDefinition;
  bindings: ProviderRunBindings;
  signer: ProviderManifestSigner;
}): Promise<ProviderCanaryAuthorization> {
  const scenarioId = parseScenarioId(
    input.scenario.id,
    "authorization.scenario.id",
  );
  const operationKind =
    providerCanaryControllerContract(scenarioId).operationKind;
  if (input.bindings.target.operation.kind !== operationKind) {
    fail("authorization scenario does not match the bound operation kind");
  }
  const canonicalScenario = await canonicalProviderCanaryDefinition(scenarioId);
  if (
    !createProviderCanaryScenarioSnapshot({
      definition: input.scenario,
      operationKind,
    }).equals(
      createProviderCanaryScenarioSnapshot({
        definition: canonicalScenario,
        operationKind,
      }),
    )
  ) {
    fail(
      "authorization requires the repository-owned canonical scenario definition",
    );
  }
  if (!SHA256_PATTERN.test(input.signer.keyId))
    fail("signer.keyId must be a lowercase SHA-256 digest");
  const publicKey = createPublicKey(input.signer.publicKeyPem);
  if (
    publicKey.asymmetricKeyType !== "ed25519" ||
    providerObserverKeyId(input.signer.publicKeyPem) !== input.signer.keyId
  ) {
    fail("signer public key must be Ed25519 and match signer.keyId");
  }
  if (input.bindings.trust.manifestAuthorityKeyId !== input.signer.keyId)
    fail("signer.keyId does not match bindings.trust.manifestAuthorityKeyId");
  const manifest: ProviderQualificationManifest =
    createProviderQualificationManifest({
      scenario: input.scenario,
      bindings: input.bindings,
    });
  const signature = await input.signer.signManifest(
    providerManifestSigningBytes(manifest),
  );
  if (!(signature instanceof Uint8Array) || signature.byteLength !== 64)
    fail("signer must return exactly one 64-byte Ed25519 signature");
  if (
    !verifySignature(
      null,
      providerManifestSigningBytes(manifest),
      publicKey,
      signature,
    )
  ) {
    fail("signer returned an invalid Ed25519 signature");
  }
  return Object.freeze({
    schema: "eliza.provider-canary-authorization.v1",
    manifest,
    manifestSignature: Object.freeze({
      keyId: input.signer.keyId,
      manifestSha256: manifest.manifestSha256,
      signature: Buffer.from(signature).toString("base64url"),
    }),
  });
}
