/**
 * Binds one portable v4 qualification artifact to a separately signed cleanup
 * result without changing the artifact's established trust contract. Release
 * catalogs consume this publication capsule, never an unaccompanied artifact.
 */

import {
  type SignedProviderCleanupProof,
  verifyProviderCleanupProof,
} from "./controller-orchestrator-bridge.ts";
import { canonicalJsonValue, canonicalSha256 } from "./manifest.ts";
import {
  normalizeProviderQualificationPublicKeyPins,
  type ProviderQualificationArtifact,
  type ProviderQualificationPublicKeyPin,
  reverifyProviderQualificationArtifact,
  validateProviderQualificationArtifact,
} from "./qualification-artifact.ts";

export const PROVIDER_QUALIFICATION_PUBLICATION_SCHEMA =
  "eliza.provider-qualification-publication.v1" as const;

export interface ProviderQualificationPublicationCapsule {
  schema: typeof PROVIDER_QUALIFICATION_PUBLICATION_SCHEMA;
  publicationSha256: string;
  createdAtIso: string;
  scenarioId: string;
  runId: string;
  runNonce: string;
  manifestSha256: string;
  artifactSha256: string;
  cleanupScopeSha256: string;
  rawControllerMaterialSha256: string;
  cleanupProofSha256: string;
  cleanupSignerPin: ProviderQualificationPublicKeyPin;
  cleanupProof: SignedProviderCleanupProof;
  qualificationArtifact: ProviderQualificationArtifact;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function fail(message: string): never {
  throw new Error(`provider qualification publication ${message}`);
}

function exactRecord(
  value: unknown,
  label: string,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    fail(`${label} must be a plain object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const missing = keys.filter((key) => descriptors[key] === undefined);
  const unknown = Object.keys(descriptors).filter((key) => !keys.includes(key));
  const accessors = Object.entries(descriptors)
    .filter(([, descriptor]) => !("value" in descriptor))
    .map(([key]) => key);
  if (missing.length > 0 || unknown.length > 0 || accessors.length > 0) {
    fail(
      `${label} violates the closed data shape (missing=${missing.join(",") || "none"}; unknown=${unknown.join(",") || "none"}; accessors=${accessors.join(",") || "none"})`,
    );
  }
  return value as Record<string, unknown>;
}

function validIso(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  ) {
    fail(`${label} must be a canonical ISO timestamp`);
  }
  return value;
}

function hash(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    fail(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function normalizedCleanupPin(
  value: unknown,
): ProviderQualificationPublicKeyPin {
  const pin = exactRecord(value, "cleanupSignerPin", [
    "keyId",
    "algorithm",
    "spkiPem",
  ]) as unknown as ProviderQualificationPublicKeyPin;
  const normalized = normalizeProviderQualificationPublicKeyPins(
    [pin.spkiPem],
    "cleanupSignerPin",
  )[0];
  if (
    pin.algorithm !== "ed25519" ||
    pin.keyId !== normalized.keyId ||
    pin.spkiPem !== normalized.spkiPem
  ) {
    fail("cleanupSignerPin does not match its canonical Ed25519 SPKI");
  }
  return normalized;
}

function reverifyCore(
  publication: ProviderQualificationPublicationCapsule,
): ProviderQualificationPublicationCapsule {
  const artifact = validateProviderQualificationArtifact(
    publication.qualificationArtifact,
  );
  reverifyProviderQualificationArtifact(artifact);
  if (
    !artifact.decision.qualification.publishable ||
    artifact.qualifiedReport === undefined
  ) {
    fail("requires a publishable independently reverified artifact");
  }
  const pin = normalizedCleanupPin(publication.cleanupSignerPin);
  const manifest = artifact.reverification.manifest;
  const proof = verifyProviderCleanupProof({
    proof: publication.cleanupProof,
    pinnedPublicKeysPem: [pin.spkiPem],
    expected: {
      scenarioId: artifact.scenarioId as Parameters<
        typeof verifyProviderCleanupProof
      >[0]["expected"]["scenarioId"],
      runId: artifact.runId,
      runNonce: manifest.run.nonce,
      manifestSha256: artifact.manifestSha256,
      cleanupScopeSha256: publication.cleanupScopeSha256,
      rawControllerMaterialSha256: publication.rawControllerMaterialSha256,
      qualificationArtifactSha256: artifact.artifactSha256,
      scenarioEndedAtIso:
        artifact.reverification.trajectoryInventory.scenarioEndedAtIso,
      keyId: pin.keyId,
    },
    now: new Date(publication.createdAtIso),
  });
  const cleanupProofSha256 = canonicalSha256(proof, "cleanupProof");
  const artifactCreatedAt = Date.parse(artifact.createdAtIso);
  const cleanupCompletedAt = Date.parse(proof.payload.completedAtIso);
  const publicationCreatedAt = Date.parse(publication.createdAtIso);
  if (
    cleanupCompletedAt < artifactCreatedAt ||
    publicationCreatedAt < cleanupCompletedAt
  ) {
    fail(
      "chronology does not prove cleanup after qualification and before publication",
    );
  }
  const manifestAuthorizedObserverKeyIds = new Set(
    manifest.trust.observerSigners.map((signer) => signer.keyId),
  );
  const pinnedObserver =
    artifact.reverification.publicKeyPins.providerObservers.find(
      (candidate) => candidate.keyId === pin.keyId,
    );
  if (
    !manifestAuthorizedObserverKeyIds.has(pin.keyId) ||
    pinnedObserver?.spkiPem !== pin.spkiPem
  ) {
    fail("cleanup signer is not an exact manifest-authorized observer signer");
  }
  if (
    publication.scenarioId !== artifact.scenarioId ||
    publication.runId !== artifact.runId ||
    publication.runNonce !== manifest.run.nonce ||
    publication.manifestSha256 !== artifact.manifestSha256 ||
    publication.artifactSha256 !== artifact.artifactSha256 ||
    publication.cleanupScopeSha256 !== proof.payload.cleanupScopeSha256 ||
    publication.rawControllerMaterialSha256 !==
      proof.payload.rawControllerMaterialSha256 ||
    publication.cleanupProofSha256 !== cleanupProofSha256
  ) {
    fail(
      "top-level projection does not match the signed artifact and cleanup proof",
    );
  }
  return publication;
}

/** Validate and independently reverify a persisted publication capsule. */
export function reverifyProviderQualificationPublication(
  value: unknown,
): ProviderQualificationPublicationCapsule {
  const publication = canonicalJsonValue(
    value,
    "providerQualificationPublication",
  ) as unknown as ProviderQualificationPublicationCapsule;
  const record = exactRecord(publication, "capsule", [
    "schema",
    "publicationSha256",
    "createdAtIso",
    "scenarioId",
    "runId",
    "runNonce",
    "manifestSha256",
    "artifactSha256",
    "cleanupScopeSha256",
    "rawControllerMaterialSha256",
    "cleanupProofSha256",
    "cleanupSignerPin",
    "cleanupProof",
    "qualificationArtifact",
  ]);
  if (record.schema !== PROVIDER_QUALIFICATION_PUBLICATION_SCHEMA) {
    fail("schema is unsupported");
  }
  validIso(record.createdAtIso, "createdAtIso");
  for (const key of [
    "publicationSha256",
    "manifestSha256",
    "artifactSha256",
    "cleanupScopeSha256",
    "rawControllerMaterialSha256",
    "cleanupProofSha256",
  ]) {
    hash(record[key], key);
  }
  const { publicationSha256, ...core } = publication;
  if (
    canonicalSha256(core, "providerQualificationPublication") !==
    publicationSha256
  ) {
    fail("capsule digest does not match");
  }
  return reverifyCore(publication);
}

/** Assemble a public capsule only after cleanup has been signed and verified. */
export function assembleProviderQualificationPublication(input: {
  artifact: ProviderQualificationArtifact;
  cleanupProof: SignedProviderCleanupProof;
  cleanupPublicKeyPem: string;
  createdAtIso: string;
}): ProviderQualificationPublicationCapsule {
  const cleanupSignerPin = normalizeProviderQualificationPublicKeyPins(
    [input.cleanupPublicKeyPem],
    "cleanupPublicKeyPem",
  )[0];
  const core = canonicalJsonValue(
    {
      schema: PROVIDER_QUALIFICATION_PUBLICATION_SCHEMA,
      createdAtIso: input.createdAtIso,
      scenarioId: input.artifact.scenarioId,
      runId: input.artifact.runId,
      runNonce: input.artifact.reverification.manifest.run.nonce,
      manifestSha256: input.artifact.manifestSha256,
      artifactSha256: input.artifact.artifactSha256,
      cleanupScopeSha256: input.cleanupProof.payload.cleanupScopeSha256,
      rawControllerMaterialSha256:
        input.cleanupProof.payload.rawControllerMaterialSha256,
      cleanupProofSha256: canonicalSha256(input.cleanupProof, "cleanupProof"),
      cleanupSignerPin,
      cleanupProof: input.cleanupProof,
      qualificationArtifact: input.artifact,
    },
    "providerQualificationPublication",
  ) as unknown as Omit<
    ProviderQualificationPublicationCapsule,
    "publicationSha256"
  >;
  return reverifyProviderQualificationPublication({
    ...core,
    publicationSha256: canonicalSha256(
      core,
      "providerQualificationPublication",
    ),
  });
}
