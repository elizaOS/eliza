/**
 * Authenticates one exact manifest-v3 generation into isolated candidate
 * staging. This kernel deliberately owns no DB, boot, route, Agent, failover,
 * multipart, discovery, or live-sandbox effect.
 */

import { createHash, createHmac } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { ElizaError } from "@elizaos/core";
import {
  AGENT_BACKUP_PAYLOAD_DIGEST_DERIVATION,
  AGENT_BACKUP_RECORD_STREAM_V1_FORMAT,
  AGENT_BACKUP_RESTORE_V3_STREAM_COMPONENTS,
  AGENT_BACKUP_RESTORE_V3_STREAM_RECEIPT_FORMAT,
  type AgentBackupManifestV3,
  type AgentBackupRestoreV3AuthorityFence,
  type AgentBackupRestoreV3AuthorityObservation,
  type AgentBackupRestoreV3CandidateReceipt,
  AgentBackupRestoreV3CandidateReceiptSchema,
  type AgentBackupRestoreV3CandidateSealAuthority,
  type AgentBackupRestoreV3CandidateSealAuthorization,
  type AgentBackupRestoreV3ComponentReceipt,
  type AgentBackupRestoreV3ExactReadReceiptProof,
  type AgentBackupRestoreV3IsolatedCandidateStaging,
  type AgentBackupRestoreV3OperationControl,
  type AgentBackupRestoreV3SourceAuthority,
  type AgentBackupRestoreV3SourceAuthorityObject,
  AgentBackupRestoreV3SourceAuthorityObjectSchema,
  type AgentBackupRestoreV3SourceObjectReceipt,
  type AgentBackupRestoreV3StagingSession,
  computeAgentBackupRestoreV3SourceAuthoritySha256,
  createAgentBackupRestoreV3CandidateSealAuthorizationRequest,
  parseAgentBackupManifestV3,
  parseAgentBackupRestoreV3AuthorityFence,
  parseAgentBackupRestoreV3SourceAuthority,
  parseAgentBackupRestoreV3StagingSession,
  validateAgentBackupRestoreV3CandidateContext,
  validateAgentBackupRestoreV3CandidateSealAuthorization,
} from "@elizaos/shared";
import {
  type ExactObjectRead,
  type ExactObjectReadLocator,
  ObjectLocatorReceipt,
} from "../storage/object-store";
import {
  type AgentBackupRestoreV3ExactObjectResult,
  stageAgentBackupRestoreV3Component,
} from "./agent-backup-restore-v3-component-stage";
import {
  type AgentBackupRestoreV3Control,
  type AgentBackupRestoreV3DetachedFailureEvent,
  createAgentBackupRestoreV3Control,
} from "./agent-backup-restore-v3-control";
import { streamAgentBackupRestoreV3ExactObject } from "./agent-backup-restore-v3-exact-object";
import {
  type AgentBackupRestoreV3KeyBundleProvider,
  type AgentBackupRestoreV3OperationKeyBundleAuthority,
  withAgentBackupRestoreV3OperationKeys,
} from "./agent-backup-restore-v3-key-bundle";

const LEASE_EXPIRY_MARGIN_MS = 1_000;

export interface AgentBackupRestoreV3PreparedObject {
  /** Locator-free canonical projection, duplicated here to prevent slot drift. */
  readonly authority: AgentBackupRestoreV3SourceAuthorityObject;
  /** Private exact key plus immutable provider-generation receipt. */
  readonly locator: ExactObjectReadLocator;
}

export interface AgentBackupRestoreV3PreparedSource {
  /** Untrusted wire value: every self-digest is recomputed before side effects. */
  readonly manifest: unknown;
  readonly authority: AgentBackupRestoreV3AuthorityFence;
  readonly sourceAuthority: AgentBackupRestoreV3SourceAuthority;
  readonly operationKeyBundle: AgentBackupRestoreV3OperationKeyBundleAuthority;
  readonly objects: readonly AgentBackupRestoreV3PreparedObject[];
}

export interface StreamAgentBackupRestoreV3Input {
  readonly source: AgentBackupRestoreV3PreparedSource;
  /** Opens only the exact private locator already paired with this slot. */
  readonly openExactObject: (
    object: Readonly<AgentBackupRestoreV3PreparedObject>,
    control: Readonly<AgentBackupRestoreV3OperationControl>,
  ) => ExactObjectRead | PromiseLike<ExactObjectRead>;
  readonly keyBundle: AgentBackupRestoreV3KeyBundleProvider;
  /** Atomically re-reads the exact live lease and catalogue fence. */
  readonly revalidateAuthority: (
    authority: Readonly<AgentBackupRestoreV3AuthorityFence>,
    control: Readonly<AgentBackupRestoreV3OperationControl>,
  ) =>
    | AgentBackupRestoreV3AuthorityObservation
    | PromiseLike<AgentBackupRestoreV3AuthorityObservation>;
  readonly candidateSealAuthority: AgentBackupRestoreV3CandidateSealAuthority;
  readonly isolatedCandidateStaging: AgentBackupRestoreV3IsolatedCandidateStaging;
  readonly signal: AbortSignal;
  readonly deadlineEpochMs: number;
  /** Mandatory sink for cleanup/settlement failures observed after interruption. */
  readonly reportDetachedFailure: (
    event: Readonly<AgentBackupRestoreV3DetachedFailureEvent>,
  ) => void | PromiseLike<void>;
  /** Injected only for deterministic boundary tests. */
  readonly now?: () => number;
}

export interface StreamAgentBackupRestoreV3Result {
  readonly sealed: true;
  readonly receipt: AgentBackupRestoreV3CandidateReceipt;
}

interface ValidatedSource {
  readonly manifest: AgentBackupManifestV3;
  readonly authority: AgentBackupRestoreV3AuthorityFence;
  readonly sourceAuthority: AgentBackupRestoreV3SourceAuthority;
  readonly sourceAuthoritySha256: string;
  readonly operationKeyBundle: AgentBackupRestoreV3OperationKeyBundleAuthority;
  readonly objects: readonly Readonly<AgentBackupRestoreV3PreparedObject>[];
}

interface AuthenticatedCandidateParts {
  readonly keyBundleGenerationId: string;
  readonly components: readonly AgentBackupRestoreV3ComponentReceipt[];
  readonly exactReadProofs: readonly AgentBackupRestoreV3ExactReadReceiptProof[];
  readonly sourceObjects: readonly AgentBackupRestoreV3SourceObjectReceipt[];
  readonly stagedPayloadBytes: number;
  readonly stagedDataRecordCount: number;
}

export type AgentBackupRestoreV3StreamErrorCode =
  | "AGENT_BACKUP_RESTORE_V3_ABORT_UNCONFIRMED"
  | "AGENT_BACKUP_RESTORE_V3_AUTHORITY_MISMATCH"
  | "AGENT_BACKUP_RESTORE_V3_AUTHORITY_STALE"
  | "AGENT_BACKUP_RESTORE_V3_CLOCK_INVALID"
  | "AGENT_BACKUP_RESTORE_V3_COLLABORATOR_INVALID"
  | "AGENT_BACKUP_RESTORE_V3_COMPONENT_SET_INVALID"
  | "AGENT_BACKUP_RESTORE_V3_FAILED"
  | "AGENT_BACKUP_RESTORE_V3_FRAMED_HMAC_MISMATCH"
  | "AGENT_BACKUP_RESTORE_V3_FRAMING_INVALID"
  | "AGENT_BACKUP_RESTORE_V3_KEY_USE_RESULT_MISSING"
  | "AGENT_BACKUP_RESTORE_V3_LOCATOR_INVALID"
  | "AGENT_BACKUP_RESTORE_V3_LOCATOR_MISMATCH"
  | "AGENT_BACKUP_RESTORE_V3_ROLLBACK_FAILED"
  | "AGENT_BACKUP_RESTORE_V3_SEAL_CONFLICT"
  | "AGENT_BACKUP_RESTORE_V3_SEAL_REPLAY_FAILED"
  | "AGENT_BACKUP_RESTORE_V3_SOURCE_INCOMPLETE"
  | "AGENT_BACKUP_RESTORE_V3_SOURCE_INVALID"
  | "AGENT_BACKUP_RESTORE_V3_SOURCE_SLOT_MISMATCH"
  | "AGENT_BACKUP_RESTORE_V3_STAGING_SESSION_INVALID";

export class AgentBackupRestoreV3StreamError extends ElizaError {
  override readonly name = "AgentBackupRestoreV3StreamError";

  constructor(
    code: AgentBackupRestoreV3StreamErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, {
      code,
      cause: options?.cause,
      context: { subsystem: "agent-backup-restore-v3-stream" },
      severity: "fatal",
    });
  }
}

function streamError(
  code: AgentBackupRestoreV3StreamErrorCode,
  message: string,
  cause?: unknown,
): never {
  throw new AgentBackupRestoreV3StreamError(code, message, { cause });
}

function isStreamError(cause: unknown): cause is AgentBackupRestoreV3StreamError {
  return cause instanceof AgentBackupRestoreV3StreamError;
}

function normalizeFailure(cause: unknown): ElizaError {
  if (cause instanceof ElizaError) return cause;
  return new AgentBackupRestoreV3StreamError(
    "AGENT_BACKUP_RESTORE_V3_FAILED",
    "Restore-v3 streaming failed at an untrusted collaborator boundary",
    { cause },
  );
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function nowEpochMs(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
    streamError(
      "AGENT_BACKUP_RESTORE_V3_CLOCK_INVALID",
      "Restore-v3 requires a canonical millisecond clock",
    );
  }
  return value;
}

function uint64BigEndian(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    streamError(
      "AGENT_BACKUP_RESTORE_V3_FRAMING_INVALID",
      "Restore-v3 framed length is not a canonical uint64",
    );
  }
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), false);
  return bytes;
}

function sha256Fingerprint(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function snapshotLocator(value: ExactObjectReadLocator): ExactObjectReadLocator {
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.key !== "string" ||
    value.key.length === 0 ||
    !value.receipt ||
    typeof value.receipt !== "object"
  ) {
    streamError(
      "AGENT_BACKUP_RESTORE_V3_LOCATOR_INVALID",
      "Restore-v3 prepared object lacks an exact private locator",
    );
  }
  const receipt = value.receipt;
  try {
    return Object.freeze({
      key: value.key,
      receipt: new ObjectLocatorReceipt({
        transport: receipt.transport,
        provider: receipt.provider,
        endpointAlias: receipt.endpointAlias,
        backendIdentityFingerprint: receipt.backendIdentityFingerprint,
        bucket: receipt.bucket,
        region: receipt.region,
        keyFingerprint: receipt.keyFingerprint,
        version: receipt.version,
        versionSource: receipt.versionSource,
      }),
    });
  } catch (cause) {
    // error-policy:J3 private locator fields are untrusted persisted input and
    // must become a structured failure without leaking their values.
    streamError(
      "AGENT_BACKUP_RESTORE_V3_LOCATOR_INVALID",
      "Restore-v3 prepared object locator is malformed",
      cause,
    );
  }
}

function expectedProviderGeneration(object: Readonly<AgentBackupRestoreV3SourceAuthorityObject>): {
  readonly version: string;
  readonly source: "provider" | "etag" | "checksum";
} {
  const catalog = object.catalog;
  if (catalog.providerVersionId !== null) {
    return { version: catalog.providerVersionId, source: "provider" };
  }
  if (catalog.providerEtag !== null) {
    return { version: catalog.providerEtag, source: "etag" };
  }
  if (catalog.providerChecksum !== null) {
    return {
      version: catalog.providerChecksum.slice("sha256:base64:".length),
      source: "checksum",
    };
  }
  streamError(
    "AGENT_BACKUP_RESTORE_V3_SOURCE_INVALID",
    "Restore-v3 source object lacks immutable provider generation authority",
  );
}

function locatorMatchesAuthority(prepared: Readonly<AgentBackupRestoreV3PreparedObject>): boolean {
  const catalog = prepared.authority.catalog;
  const receipt = prepared.locator.receipt;
  const generation = expectedProviderGeneration(prepared.authority);
  return (
    receipt.transport ===
      (catalog.transport === "worker-r2" ? "worker-r2-binding" : "s3-compatible") &&
    receipt.provider === (catalog.provider === "cloudflare-r2" ? "r2" : "s3") &&
    receipt.backendIdentityFingerprint === catalog.endpointIdentityFingerprint &&
    sha256Fingerprint(receipt.endpointAlias) === catalog.endpointAliasFingerprint &&
    sha256Fingerprint(receipt.bucket) === catalog.bucketFingerprint &&
    sha256Fingerprint(receipt.region) === catalog.regionFingerprint &&
    sha256Fingerprint(prepared.locator.key) === catalog.keyFingerprint &&
    receipt.keyFingerprint === catalog.keyFingerprint &&
    receipt.version === generation.version &&
    receipt.versionSource === generation.source
  );
}

function snapshotPreparedObjects(
  value: readonly AgentBackupRestoreV3PreparedObject[],
  expectedCount: number,
): readonly Readonly<AgentBackupRestoreV3PreparedObject>[] {
  if (!Array.isArray(value) || value.length !== expectedCount) {
    streamError(
      "AGENT_BACKUP_RESTORE_V3_SOURCE_INCOMPLETE",
      "Restore-v3 prepared object inventory cardinality differs from source authority",
    );
  }
  try {
    return Object.freeze(
      value.map((entry) => {
        const prepared = Object.freeze({
          authority: freezeDeep(
            AgentBackupRestoreV3SourceAuthorityObjectSchema.parse(entry.authority),
          ),
          locator: snapshotLocator(entry.locator),
        });
        if (!locatorMatchesAuthority(prepared)) {
          streamError(
            "AGENT_BACKUP_RESTORE_V3_LOCATOR_MISMATCH",
            "Restore-v3 private locator differs from canonical source authority",
          );
        }
        return prepared;
      }),
    );
  } catch (cause) {
    // error-policy:J3 the prepared inventory and provider receipts are
    // untrusted persisted input; malformed entries fail closed before effects.
    if (isStreamError(cause)) throw cause;
    streamError(
      "AGENT_BACKUP_RESTORE_V3_SOURCE_INVALID",
      "Restore-v3 prepared object inventory is malformed",
      cause,
    );
  }
}

function validateFullManifest(manifest: Readonly<AgentBackupManifestV3>): void {
  if (
    manifest.chain.kind !== "full" ||
    manifest.components.length !== AGENT_BACKUP_RESTORE_V3_STREAM_COMPONENTS.length
  ) {
    streamError(
      "AGENT_BACKUP_RESTORE_V3_COMPONENT_SET_INVALID",
      "Restore-v3 requires one exact full five-component manifest",
    );
  }
  for (const [index, name] of AGENT_BACKUP_RESTORE_V3_STREAM_COMPONENTS.entries()) {
    const component = manifest.components[index];
    if (
      !component ||
      component.name !== name ||
      component.format !== AGENT_BACKUP_RECORD_STREAM_V1_FORMAT ||
      component.compression !== "none" ||
      component.state.kind !== "full" ||
      component.chunks.length === 0
    ) {
      streamError(
        "AGENT_BACKUP_RESTORE_V3_COMPONENT_SET_INVALID",
        "Restore-v3 manifest components are incomplete or not exact record streams",
      );
    }
  }
}

async function validatePreparedSource(
  sourceInput: Readonly<AgentBackupRestoreV3PreparedSource>,
  control: AgentBackupRestoreV3Control,
  now: () => number,
): Promise<ValidatedSource> {
  let authority: AgentBackupRestoreV3AuthorityFence;
  let sourceAuthority: AgentBackupRestoreV3SourceAuthority;
  let manifestValidation: Promise<AgentBackupManifestV3>;
  let objects: readonly Readonly<AgentBackupRestoreV3PreparedObject>[];
  let operationKeyBundle: AgentBackupRestoreV3OperationKeyBundleAuthority;
  try {
    authority = parseAgentBackupRestoreV3AuthorityFence(sourceInput.authority);
    sourceAuthority = parseAgentBackupRestoreV3SourceAuthority(sourceInput.sourceAuthority);
    objects = snapshotPreparedObjects(sourceInput.objects, sourceAuthority.objects.length);
    operationKeyBundle = freezeDeep({ ...sourceInput.operationKeyBundle });
    // The async parser snapshots its complete Zod shell synchronously before
    // its first await, closing manifest mutation during digest validation.
    manifestValidation = parseAgentBackupManifestV3(sourceInput.manifest);
  } catch (cause) {
    // error-policy:J3 every persisted source shell is snapshotted and parsed
    // before staging or provider I/O; malformed input never degrades.
    if (isStreamError(cause)) throw cause;
    streamError(
      "AGENT_BACKUP_RESTORE_V3_SOURCE_INVALID",
      "Restore-v3 manifest or durable source authority is invalid",
      cause,
    );
  }
  let manifest: AgentBackupManifestV3;
  try {
    manifest = freezeDeep(await control.wait("Manifest-v3 validation", () => manifestValidation));
  } catch (cause) {
    // error-policy:J2 canonical async manifest validation is translated at the
    // source boundary while preserving its cause.
    streamError(
      "AGENT_BACKUP_RESTORE_V3_SOURCE_INVALID",
      "Restore-v3 manifest failed canonical validation",
      cause,
    );
  }
  validateFullManifest(manifest);
  const currentEpochMs = nowEpochMs(now);
  if (
    authority.organizationId !== manifest.identity.organizationId ||
    authority.agentId !== manifest.identity.agentId ||
    authority.operationId !== manifest.operationId ||
    authority.sourceActivationGeneration !== manifest.identity.activationGeneration ||
    authority.sourceLifecycleRevision !== manifest.identity.lifecycleRevision ||
    authority.expectedManifestSha256 !== manifest.integrity.manifestSha256 ||
    sourceAuthority.organizationId !== authority.organizationId ||
    sourceAuthority.agentId !== authority.agentId ||
    sourceAuthority.backupId !== authority.backupId ||
    sourceAuthority.operationId !== authority.operationId ||
    sourceAuthority.sourceActivationGeneration !== authority.sourceActivationGeneration ||
    sourceAuthority.sourceLifecycleRevision !== authority.sourceLifecycleRevision ||
    sourceAuthority.expectedManifestSha256 !== authority.expectedManifestSha256 ||
    sourceAuthority.copyRole !== authority.copyRole ||
    sourceAuthority.catalogEpoch !== authority.catalogEpoch ||
    authority.leaseExpiresAtEpochMs <= currentEpochMs + LEASE_EXPIRY_MARGIN_MS ||
    control.deadlineEpochMs >= authority.leaseExpiresAtEpochMs - LEASE_EXPIRY_MARGIN_MS
  ) {
    streamError(
      "AGENT_BACKUP_RESTORE_V3_AUTHORITY_MISMATCH",
      "Restore-v3 authority differs from its manifest or safe lease window",
    );
  }

  const slots = manifest.components.flatMap((component, componentIndex) =>
    component.chunks.map((chunk) => ({
      componentIndex,
      componentName: component.name,
      chunk,
    })),
  );
  if (slots.length !== sourceAuthority.objects.length || slots.length !== objects.length) {
    streamError(
      "AGENT_BACKUP_RESTORE_V3_SOURCE_INCOMPLETE",
      "Restore-v3 object inventory does not cover every manifest slot",
    );
  }
  for (const [index, slot] of slots.entries()) {
    const sourceObject = sourceAuthority.objects[index];
    const prepared = objects[index];
    if (
      !sourceObject ||
      !prepared ||
      sourceObject.componentIndex !== slot.componentIndex ||
      sourceObject.componentName !== slot.componentName ||
      sourceObject.chunkIndex !== slot.chunk.index ||
      sourceObject.copyRole !== authority.copyRole ||
      sourceObject.contentHmacSha256 !== slot.chunk.contentHmacSha256 ||
      sourceObject.catalog.ciphertextSha256 !== slot.chunk.sha256 ||
      sourceObject.catalog.sizeBytes !== slot.chunk.encryptedBytes ||
      !isDeepStrictEqual(prepared.authority, sourceObject)
    ) {
      streamError(
        "AGENT_BACKUP_RESTORE_V3_SOURCE_SLOT_MISMATCH",
        `Restore-v3 prepared source slot ${index} differs from manifest authority`,
      );
    }
  }
  const sourceAuthoritySha256 = await control.wait("Source authority digest", () =>
    computeAgentBackupRestoreV3SourceAuthoritySha256(sourceAuthority),
  );
  return Object.freeze({
    manifest,
    authority,
    sourceAuthority,
    sourceAuthoritySha256,
    operationKeyBundle,
    objects,
  });
}

function validateSession(
  value: unknown,
  authority: Readonly<AgentBackupRestoreV3AuthorityFence>,
): Readonly<AgentBackupRestoreV3StagingSession> {
  try {
    const session = parseAgentBackupRestoreV3StagingSession(value);
    if (
      session.restoreAttemptId !== authority.restoreAttemptId ||
      session.operationId !== authority.operationId ||
      session.expectedManifestSha256 !== authority.expectedManifestSha256 ||
      session.cleanupRegistered !== true ||
      session.isolatedCandidate !== true
    ) {
      streamError(
        "AGENT_BACKUP_RESTORE_V3_STAGING_SESSION_INVALID",
        "Isolated staging returned a session for different authority",
      );
    }
    return session;
  } catch (cause) {
    // error-policy:J3 a staging adapter response is an untrusted authority
    // boundary and must match the exact session before it can be retained.
    if (isStreamError(cause)) throw cause;
    streamError(
      "AGENT_BACKUP_RESTORE_V3_STAGING_SESSION_INVALID",
      "Isolated staging returned a malformed session",
      cause,
    );
  }
}

function validateAuthorityObservation(
  value: unknown,
  expected: Readonly<AgentBackupRestoreV3AuthorityFence>,
): void {
  try {
    const observation = value as AgentBackupRestoreV3AuthorityObservation;
    const authority = parseAgentBackupRestoreV3AuthorityFence(observation.authority);
    if (observation.current !== true || !isDeepStrictEqual(authority, expected)) {
      streamError(
        "AGENT_BACKUP_RESTORE_V3_AUTHORITY_STALE",
        "Restore-v3 durable authority changed during candidate staging",
      );
    }
  } catch (cause) {
    // error-policy:J3 a durable authority observation is untrusted adapter
    // output and cannot be treated as current unless its exact fence parses.
    if (isStreamError(cause)) throw cause;
    streamError(
      "AGENT_BACKUP_RESTORE_V3_AUTHORITY_STALE",
      "Restore-v3 authority revalidation returned malformed state",
      cause,
    );
  }
}

async function abortSession(
  control: AgentBackupRestoreV3Control,
  staging: AgentBackupRestoreV3IsolatedCandidateStaging,
  session: Readonly<AgentBackupRestoreV3StagingSession>,
): Promise<void> {
  const acknowledged = await control.cleanup("Isolated staging rollback", (cleanupControl) =>
    staging.abort(session, "staging-failed", cleanupControl),
  );
  if (acknowledged !== true) {
    streamError(
      "AGENT_BACKUP_RESTORE_V3_ABORT_UNCONFIRMED",
      "Isolated staging rollback was not acknowledged",
    );
  }
}

async function sealCandidateWithExactReplay(
  control: AgentBackupRestoreV3Control,
  staging: AgentBackupRestoreV3IsolatedCandidateStaging,
  session: Readonly<AgentBackupRestoreV3StagingSession>,
  candidate: Readonly<AgentBackupRestoreV3CandidateReceipt>,
  authorization: Readonly<AgentBackupRestoreV3CandidateSealAuthorization>,
): Promise<AgentBackupRestoreV3CandidateReceipt> {
  const seal = async (
    sealControl: Readonly<AgentBackupRestoreV3OperationControl>,
  ): Promise<AgentBackupRestoreV3CandidateReceipt> => {
    const sealed = AgentBackupRestoreV3CandidateReceiptSchema.parse(
      await staging.seal(session, candidate, authorization, sealControl),
    );
    if (!isDeepStrictEqual(sealed, candidate)) {
      streamError(
        "AGENT_BACKUP_RESTORE_V3_SEAL_CONFLICT",
        "Isolated staging returned a conflicting candidate receipt",
      );
    }
    return sealed;
  };

  let firstSealStarted = false;
  try {
    return await control.wait("Isolated candidate seal", () => {
      firstSealStarted = true;
      return seal(control);
    });
  } catch (firstFailure) {
    // error-policy:J2 an ambiguous first seal failure permits only one
    // byte-identical replay under the same durable authorization.
    if (!firstSealStarted) throw firstFailure;
    try {
      // A fresh bounded control lets the adapter perform the contract's
      // read-only exact replay after the operation deadline. The original
      // operation control remains visible to the adapter, so an interrupted
      // call may read an already-sealed exact receipt but cannot create a new
      // transition. The fresh cleanup control only bounds that reconciliation.
      return await control.cleanup("Isolated candidate seal exact response-loss replay", () =>
        seal(control),
      );
    } catch (replayFailure) {
      // error-policy:J2 both exact attempts are retained behind one structured
      // terminal error for reconciliation.
      streamError(
        "AGENT_BACKUP_RESTORE_V3_SEAL_REPLAY_FAILED",
        "Candidate seal and exact response-loss replay both failed",
        new AggregateError([normalizeFailure(firstFailure), normalizeFailure(replayFailure)]),
      );
    }
  }
}

async function authenticateCandidate(
  source: Readonly<ValidatedSource>,
  session: Readonly<AgentBackupRestoreV3StagingSession>,
  control: AgentBackupRestoreV3Control,
  staging: AgentBackupRestoreV3IsolatedCandidateStaging,
  keyBundle: AgentBackupRestoreV3KeyBundleProvider,
  openExactObject: StreamAgentBackupRestoreV3Input["openExactObject"],
): Promise<AuthenticatedCandidateParts> {
  let authenticatedParts: AuthenticatedCandidateParts | undefined;
  await withAgentBackupRestoreV3OperationKeys(
    {
      authority: source.operationKeyBundle,
      manifest: source.manifest,
      provider: keyBundle,
      control,
    },
    async (keys) => {
      const framedHmac = createHmac("sha256", keys.contentHmacKey);
      try {
        const encoder = new TextEncoder();
        framedHmac.update(encoder.encode(AGENT_BACKUP_PAYLOAD_DIGEST_DERIVATION));
        framedHmac.update(uint64BigEndian(AGENT_BACKUP_RESTORE_V3_STREAM_COMPONENTS.length));
        const operationNonceOwners = new Map<string, string>();
        const components: AgentBackupRestoreV3ComponentReceipt[] = [];
        const exactReadProofs: AgentBackupRestoreV3ExactReadReceiptProof[] = [];
        const sourceObjects: AgentBackupRestoreV3SourceObjectReceipt[] = [];
        let stagedPayloadBytes = 0;
        let stagedDataRecordCount = 0;

        for (const [
          componentIndex,
          componentName,
        ] of AGENT_BACKUP_RESTORE_V3_STREAM_COMPONENTS.entries()) {
          control.assertActive("Restore-v3 component staging");
          const component = source.manifest.components[componentIndex];
          if (!component || component.name !== componentName) {
            streamError(
              "AGENT_BACKUP_RESTORE_V3_COMPONENT_SET_INVALID",
              "Restore-v3 component order changed after validation",
            );
          }
          const nameBytes = encoder.encode(componentName);
          framedHmac.update(uint64BigEndian(nameBytes.byteLength));
          framedHmac.update(nameBytes);
          framedHmac.update(uint64BigEndian(component.totals.plainBytes));
          const preparedObjects = source.objects.filter(
            (entry) => entry.authority.componentIndex === componentIndex,
          );
          const result = await stageAgentBackupRestoreV3Component({
            manifest: source.manifest,
            componentIndex,
            objectStreams: preparedObjects.map(
              (prepared) => () =>
                streamAgentBackupRestoreV3ExactObject({
                  manifest: source.manifest,
                  backupId: source.authority.backupId,
                  sourceAuthoritySha256: source.sourceAuthoritySha256,
                  sourceObject: prepared.authority,
                  openExactObject: (_sourceObject, objectControl) =>
                    Promise.resolve(openExactObject(prepared, objectControl)),
                  dek: keys.dek,
                  contentHmacKey: keys.contentHmacKey,
                  operationNonceOwners,
                  control,
                }) as AsyncGenerator<Uint8Array, AgentBackupRestoreV3ExactObjectResult, void>,
            ),
            session,
            staging,
            contentHmacKey: keys.contentHmacKey,
            observeFramedPlaintext: (bytes) => framedHmac.update(bytes),
            control,
          });
          components.push(result.component);
          exactReadProofs.push(...result.exactReadProofs);
          sourceObjects.push(...result.sourceObjects);
          stagedPayloadBytes += result.component.payloadBytes;
          stagedDataRecordCount += result.component.dataFrameCount;
        }
        if (framedHmac.digest("hex") !== source.manifest.integrity.framedContentHmacSha256) {
          streamError(
            "AGENT_BACKUP_RESTORE_V3_FRAMED_HMAC_MISMATCH",
            "Restore-v3 framed five-component HMAC differs from manifest-v3",
          );
        }
        authenticatedParts = Object.freeze({
          keyBundleGenerationId: keys.generationId,
          components: Object.freeze(components),
          exactReadProofs: Object.freeze(exactReadProofs),
          sourceObjects: Object.freeze(sourceObjects),
          stagedPayloadBytes,
          stagedDataRecordCount,
        });
      } finally {
        framedHmac.destroy();
      }
    },
  );
  if (!authenticatedParts) {
    streamError(
      "AGENT_BACKUP_RESTORE_V3_KEY_USE_RESULT_MISSING",
      "Restore-v3 key use completed without an authenticated candidate result",
    );
  }
  return authenticatedParts;
}

interface SnapshottedCollaborators {
  readonly source: Readonly<AgentBackupRestoreV3PreparedSource>;
  readonly staging: AgentBackupRestoreV3IsolatedCandidateStaging;
  readonly keyBundle: AgentBackupRestoreV3KeyBundleProvider;
  readonly openExactObject: StreamAgentBackupRestoreV3Input["openExactObject"];
  readonly revalidateAuthority: StreamAgentBackupRestoreV3Input["revalidateAuthority"];
  readonly authorizeCandidateSeal: AgentBackupRestoreV3CandidateSealAuthority["authorize"];
  readonly signal: AbortSignal;
  readonly deadlineEpochMs: number;
  readonly reportDetachedFailure: StreamAgentBackupRestoreV3Input["reportDetachedFailure"];
  readonly now: () => number;
}

function snapshotCollaborators(
  input: Readonly<StreamAgentBackupRestoreV3Input>,
): SnapshottedCollaborators {
  const source = input?.source;
  const keyBundle = input?.keyBundle;
  const staging = input?.isolatedCandidateStaging;
  const sealAuthority = input?.candidateSealAuthority;
  const openExactObject = input?.openExactObject;
  const revalidateAuthority = input?.revalidateAuthority;
  const unwrap = keyBundle?.unwrap;
  const release = keyBundle?.release;
  const begin = staging?.begin;
  const stageRecord = staging?.stageRecord;
  const finishComponent = staging?.finishComponent;
  const seal = staging?.seal;
  const abort = staging?.abort;
  const authorize = sealAuthority?.authorize;
  const reportDetachedFailure = input?.reportDetachedFailure;
  if (
    !input ||
    typeof input !== "object" ||
    !source ||
    typeof source !== "object" ||
    !keyBundle ||
    !staging ||
    !sealAuthority ||
    typeof openExactObject !== "function" ||
    typeof unwrap !== "function" ||
    typeof release !== "function" ||
    typeof revalidateAuthority !== "function" ||
    typeof authorize !== "function" ||
    typeof begin !== "function" ||
    typeof stageRecord !== "function" ||
    typeof finishComponent !== "function" ||
    typeof seal !== "function" ||
    typeof abort !== "function" ||
    typeof reportDetachedFailure !== "function" ||
    (input.now !== undefined && typeof input.now !== "function")
  ) {
    streamError(
      "AGENT_BACKUP_RESTORE_V3_COLLABORATOR_INVALID",
      "Restore-v3 streaming collaborators are incomplete",
    );
  }
  return Object.freeze({
    source: Object.freeze({
      manifest: source.manifest,
      authority: source.authority,
      sourceAuthority: source.sourceAuthority,
      operationKeyBundle: source.operationKeyBundle,
      objects: source.objects,
    }),
    staging: Object.freeze({
      begin: begin.bind(staging),
      stageRecord: stageRecord.bind(staging),
      finishComponent: finishComponent.bind(staging),
      seal: seal.bind(staging),
      abort: abort.bind(staging),
    }),
    keyBundle: Object.freeze({
      unwrap: unwrap.bind(keyBundle),
      release: release.bind(keyBundle),
    }),
    openExactObject: openExactObject.bind(input),
    revalidateAuthority: revalidateAuthority.bind(input),
    authorizeCandidateSeal: authorize.bind(sealAuthority),
    signal: input.signal,
    deadlineEpochMs: input.deadlineEpochMs,
    reportDetachedFailure: reportDetachedFailure.bind(input),
    now: input.now ?? Date.now,
  });
}

/**
 * Authenticate and seal one full exact generation as an isolated candidate.
 * Before successful return, every staged plaintext byte is unauthenticated and
 * must remain rollbackable and invisible to boot or live state. The returned
 * receipt is not a boot, activation, route, or restore commit.
 */
export async function streamAgentBackupRestoreV3(
  input: Readonly<StreamAgentBackupRestoreV3Input>,
): Promise<StreamAgentBackupRestoreV3Result> {
  const collaborators = snapshotCollaborators(input);
  const now = collaborators.now;
  const control = createAgentBackupRestoreV3Control({
    signal: collaborators.signal,
    deadlineEpochMs: collaborators.deadlineEpochMs,
    reportDetachedFailure: collaborators.reportDetachedFailure,
    now,
  });
  const { staging, keyBundle, openExactObject, revalidateAuthority, authorizeCandidateSeal } =
    collaborators;
  let cleanupSession: Readonly<AgentBackupRestoreV3StagingSession> | undefined;

  try {
    const source = await validatePreparedSource(collaborators.source, control, now);
    const openedSession = await control.wait(
      "Isolated staging acquisition",
      () => staging.begin({ authority: source.authority, manifest: source.manifest }, control),
      async (lateSession, cleanupControl) => {
        const exactLateSession = validateSession(lateSession, source.authority);
        const acknowledged = await staging.abort(
          exactLateSession,
          "staging-failed",
          cleanupControl,
        );
        if (acknowledged !== true) {
          throw new AgentBackupRestoreV3StreamError(
            "AGENT_BACKUP_RESTORE_V3_ABORT_UNCONFIRMED",
            "Late isolated staging rollback was not acknowledged",
          );
        }
      },
    );
    const session = validateSession(openedSession, source.authority);
    cleanupSession = session;

    validateAuthorityObservation(
      await control.wait("Initial restore authority revalidation", () =>
        revalidateAuthority(source.authority, control),
      ),
      source.authority,
    );

    const authenticated = await authenticateCandidate(
      source,
      session,
      control,
      staging,
      keyBundle,
      openExactObject,
    );

    // This re-read occurs only after the key wrapper has acknowledged release
    // and erased all locally observable DEK/HMAC-key views.
    validateAuthorityObservation(
      await control.wait("Final restore authority revalidation", () =>
        revalidateAuthority(source.authority, control),
      ),
      source.authority,
    );

    const candidate = freezeDeep(
      AgentBackupRestoreV3CandidateReceiptSchema.parse({
        format: AGENT_BACKUP_RESTORE_V3_STREAM_RECEIPT_FORMAT,
        restoreAttemptId: source.authority.restoreAttemptId,
        operationId: source.authority.operationId,
        expectedManifestSha256: source.authority.expectedManifestSha256,
        keyBundleGenerationId: authenticated.keyBundleGenerationId,
        sourceCopyRole: source.authority.copyRole,
        sourceAuthorityDerivation: source.sourceAuthority.derivation,
        sourceAuthoritySha256: source.sourceAuthoritySha256,
        objectCount: authenticated.sourceObjects.length,
        stagedPayloadBytes: authenticated.stagedPayloadBytes,
        stagedDataRecordCount: authenticated.stagedDataRecordCount,
        sourceObjects: authenticated.sourceObjects,
        components: authenticated.components,
        authorityRevalidated: true,
      }),
    );
    const validated = await control.wait("Candidate context validation", () =>
      validateAgentBackupRestoreV3CandidateContext({
        authority: source.authority,
        manifest: source.manifest,
        sourceAuthority: source.sourceAuthority,
        exactReadProofs: authenticated.exactReadProofs,
        receipt: candidate,
      }),
    );
    const authorizationRequest = createAgentBackupRestoreV3CandidateSealAuthorizationRequest(
      validated,
      session.executionToken,
    );
    const authorization = validateAgentBackupRestoreV3CandidateSealAuthorization(
      authorizationRequest,
      await control.wait("Candidate seal authorization", () =>
        authorizeCandidateSeal(authorizationRequest, control),
      ),
      nowEpochMs(now),
    );
    await sealCandidateWithExactReplay(control, staging, session, candidate, authorization);
    return Object.freeze({ sealed: true, receipt: validated.receipt });
  } catch (cause) {
    // error-policy:J2 every post-acquisition failure is normalized before the
    // fenced rollback, preserving an already-structured inner domain error.
    const primary = normalizeFailure(cause);
    if (!cleanupSession) throw primary;
    try {
      await abortSession(control, staging, cleanupSession);
    } catch (abortFailure) {
      // error-policy:J2 rollback failure cannot replace the primary failure;
      // both are retained behind a structured terminal reconciliation error.
      throw new AgentBackupRestoreV3StreamError(
        "AGENT_BACKUP_RESTORE_V3_ROLLBACK_FAILED",
        "Restore-v3 streaming and isolated rollback both failed",
        {
          cause: new AggregateError([primary, normalizeFailure(abortFailure)]),
        },
      );
    }
    throw primary;
  } finally {
    control.close();
  }
}

export type {
  AgentBackupRestoreV3AuthorityFence,
  AgentBackupRestoreV3CandidateReceipt,
  AgentBackupRestoreV3ComponentReceipt,
  AgentBackupRestoreV3IsolatedCandidateStaging,
  AgentBackupRestoreV3OperationControl,
  AgentBackupRestoreV3SourceAuthority,
  AgentBackupRestoreV3StagingSession,
};
