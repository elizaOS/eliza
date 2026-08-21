/**
 * Proves cleanup publication is portable and rejects missing, tampered,
 * cross-run, cross-artifact, and wrong-signer cleanup material.
 */

import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PROVIDER_CLEANUP_PROOF_SCHEMA,
  type ProviderCleanupProofPayload,
  type SignedProviderCleanupProof,
} from "./controller-orchestrator-bridge.ts";
import {
  canonicalJson,
  canonicalJsonValue,
  canonicalSha256,
} from "./manifest.ts";
import {
  assembleProviderQualificationPublication,
  reverifyProviderQualificationPublication,
} from "./publication-capsule.ts";
import { providerObserverKeyId } from "./qualification.ts";
import * as artifactModule from "./qualification-artifact.ts";
import {
  PROVIDER_QUALIFICATION_ARTIFACT_SCHEMA,
  type ProviderQualificationArtifact,
} from "./qualification-artifact.ts";
import { writeProviderQualificationPublicationIntoReservedDirectory } from "./qualification-cli.ts";

const HASH = "a".repeat(64);
const SCENARIO_ID = "provider.discord.confirmed-send";
const RUN_ID = "run-cleanup-1";
const RUN_NONCE = "nonce-cleanup-1";
const ARTIFACT_CREATED = "2026-08-20T00:00:01.000Z";
const CLEANUP_COMPLETED = "2026-08-20T00:00:02.000Z";
const PUBLICATION_CREATED = "2026-08-20T00:00:03.000Z";

function publicPem(key: KeyObject): string {
  return key.export({ type: "spki", format: "pem" }).toString();
}

function pin(key: KeyObject) {
  const spkiPem = publicPem(key);
  return {
    keyId: providerObserverKeyId(spkiPem),
    algorithm: "ed25519" as const,
    spkiPem,
  };
}

function artifact(
  trustKeys: readonly KeyObject[],
): ProviderQualificationArtifact {
  const [authorityKey, observerKey, judgeKey] = trustKeys;
  if (!authorityKey || !observerKey || !judgeKey) {
    throw new Error("artifact fixture requires three trust keys");
  }
  const manifestSha256 = "b".repeat(64);
  const runnerResult = {
    scenarioStatus: "passed" as const,
    finalChecks: [],
    runnerResultSha256: "c".repeat(64),
  };
  const core = {
    schema: PROVIDER_QUALIFICATION_ARTIFACT_SCHEMA,
    createdAtIso: ARTIFACT_CREATED,
    scenarioId: SCENARIO_ID,
    runId: RUN_ID,
    repositorySha: "d".repeat(40),
    deploymentSha: "e".repeat(64),
    manifestSha256,
    trajectorySetSha256: "f".repeat(64),
    runnerResultSha256: runnerResult.runnerResultSha256,
    observerEvidenceSha256: HASH,
    semanticEvidenceSha256: HASH,
    decision: {
      manifestSha256,
      qualification: {
        status: "qualified" as const,
        publishable: true as const,
        reasons: [] as const,
      },
      matchedObservationContracts: [],
      guarantees: {
        providerAuthorizationVerified: true,
        providerFailurePathsVerified: true,
        providerAcceptanceVerified: true,
        providerReadbackVerified: true,
        providerIdempotencyVerified: true,
        exactlyOnce: false as const,
      },
    },
    reverification: {
      scenarioDefinition: { id: SCENARIO_ID },
      manifest: {
        manifestSha256,
        run: { runId: RUN_ID, nonce: RUN_NONCE },
        trust: {
          observerSigners: [
            { observerId: "observer-1", keyId: pin(observerKey).keyId },
          ],
        },
      },
      manifestSignature: {},
      publicKeyPins: {
        manifestAuthorities: [pin(authorityKey)],
        providerObservers: [pin(observerKey)],
        semanticJudges: [pin(judgeKey)],
      },
      signedObserverEvidence: {
        payload: { runnerResultSha256: runnerResult.runnerResultSha256 },
      },
      signedSemanticJudgeEvidence: {},
      trajectoryInventory: {
        setSha256: "f".repeat(64),
        scenarioEndedAtIso: "2026-08-20T00:00:00.000Z",
      },
      runnerResult,
      verifierTranscript: {
        schema: "eliza.provider-qualification-verifier-transcript.v1",
        implementation: "@elizaos/scenario-runner/provider-qualification",
        verifiedAtIso: ARTIFACT_CREATED,
        verificationOptions: {},
        sourcePrivacy: {},
        inventory: {},
        proofDigests: {},
      },
    },
    qualifiedReport: { scenarioId: SCENARIO_ID },
  };
  return {
    ...core,
    artifactSha256: canonicalSha256(core, "providerQualificationArtifact"),
  } as unknown as ProviderQualificationArtifact;
}

function cleanupProof(input: {
  artifact: ProviderQualificationArtifact;
  privateKey: KeyObject;
  publicKey: KeyObject;
  runId?: string;
  rawControllerMaterialSha256?: string;
  qualificationArtifactSha256?: string;
}): SignedProviderCleanupProof {
  const payload: ProviderCleanupProofPayload = {
    schema: PROVIDER_CLEANUP_PROOF_SCHEMA,
    scenarioId: SCENARIO_ID,
    runId: input.runId ?? RUN_ID,
    runNonce: RUN_NONCE,
    manifestSha256: input.artifact.manifestSha256,
    cleanupScopeSha256: "1".repeat(64),
    rawControllerMaterialSha256:
      input.rawControllerMaterialSha256 ?? "2".repeat(64),
    qualificationArtifactSha256:
      input.qualificationArtifactSha256 ?? input.artifact.artifactSha256,
    disposition: "cleaned",
    completedAtIso: CLEANUP_COMPLETED,
  };
  return {
    keyId: providerObserverKeyId(publicPem(input.publicKey)),
    payload,
    signature: sign(
      null,
      Buffer.from(
        canonicalJson(canonicalJsonValue(payload, "cleanupProof")),
        "utf8",
      ),
      input.privateKey,
    ).toString("base64url"),
  };
}

describe("provider qualification publication capsule", () => {
  let reverifyArtifact: ReturnType<typeof vi.spyOn>;
  const authority = generateKeyPairSync("ed25519");
  const observer = generateKeyPairSync("ed25519");
  const judge = generateKeyPairSync("ed25519");
  const cleanup = generateKeyPairSync("ed25519");

  beforeEach(() => {
    reverifyArtifact = vi.spyOn(
      artifactModule,
      "reverifyProviderQualificationArtifact",
    );
    reverifyArtifact.mockImplementation(
      (value: unknown) => (value as ProviderQualificationArtifact).decision,
    );
  });

  afterEach(() => reverifyArtifact.mockRestore());

  function fixture() {
    const qualificationArtifact = artifact([
      authority.publicKey,
      observer.publicKey,
      judge.publicKey,
    ]);
    const proof = cleanupProof({
      artifact: qualificationArtifact,
      privateKey: observer.privateKey,
      publicKey: observer.publicKey,
    });
    return assembleProviderQualificationPublication({
      artifact: qualificationArtifact,
      cleanupProof: proof,
      cleanupPublicKeyPem: publicPem(observer.publicKey),
      createdAtIso: PUBLICATION_CREATED,
    });
  }

  it("round-trips one artifact-bound signed cleanup publication", () => {
    const publication = fixture();
    expect(reverifyProviderQualificationPublication(publication)).toEqual(
      publication,
    );
    expect(publication.cleanupProof.payload.qualificationArtifactSha256).toBe(
      publication.artifactSha256,
    );
    expect(publication.cleanupSignerPin.keyId).toBe(
      publication.cleanupProof.keyId,
    );
  });

  it("writes the artifact and publication capsule as one reserved output set", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "provider-publication-"));
    try {
      const publication = fixture();
      writeProviderQualificationPublicationIntoReservedDirectory(
        directory,
        publication,
      );
      expect(
        JSON.parse(
          readFileSync(path.join(directory, "publication.json"), "utf8"),
        ).publicationSha256,
      ).toBe(publication.publicationSha256);
      expect(
        JSON.parse(
          readFileSync(path.join(directory, "qualification.json"), "utf8"),
        ).artifactSha256,
      ).toBe(publication.artifactSha256);
      expect(
        readFileSync(path.join(directory, "publication.md"), "utf8"),
      ).toContain("Cleanup publication proof");
      expect(
        readFileSync(path.join(directory, "qualification.md"), "utf8"),
      ).toContain("Provider qualification");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects missing or accessor-backed capsule fields", () => {
    const publication = fixture() as unknown as Record<string, unknown>;
    const { cleanupProof: _missing, ...withoutProof } = publication;
    expect(() =>
      reverifyProviderQualificationPublication(withoutProof),
    ).toThrow(/missing=cleanupProof/);
    const accessor = { ...publication };
    Object.defineProperty(accessor, "cleanupProof", {
      enumerable: true,
      get: () => publication.cleanupProof,
    });
    expect(() => reverifyProviderQualificationPublication(accessor)).toThrow(
      /cleanupProof must not be an accessor property/,
    );
  });

  it("rejects a valid cleanup signature for another run or artifact", () => {
    const qualificationArtifact = artifact([
      authority.publicKey,
      observer.publicKey,
      judge.publicKey,
    ]);
    for (const proof of [
      cleanupProof({
        artifact: qualificationArtifact,
        privateKey: cleanup.privateKey,
        publicKey: cleanup.publicKey,
        runId: "run-other",
      }),
      cleanupProof({
        artifact: qualificationArtifact,
        privateKey: cleanup.privateKey,
        publicKey: cleanup.publicKey,
        qualificationArtifactSha256: "3".repeat(64),
      }),
    ]) {
      expect(() =>
        assembleProviderQualificationPublication({
          artifact: qualificationArtifact,
          cleanupProof: proof,
          cleanupPublicKeyPem: publicPem(cleanup.publicKey),
          createdAtIso: PUBLICATION_CREATED,
        }),
      ).toThrow(/invalid or cross-run proof/);
    }
  });

  it("rejects tampered raw material and the wrong signer pin", () => {
    const publication = fixture();
    const rawTamper = structuredClone(publication);
    rawTamper.cleanupProof.payload.rawControllerMaterialSha256 = "4".repeat(64);
    rawTamper.rawControllerMaterialSha256 = "4".repeat(64);
    rawTamper.cleanupProofSha256 = canonicalSha256(
      rawTamper.cleanupProof,
      "cleanupProof",
    );
    const { publicationSha256: _rawDigest, ...rawCore } = rawTamper;
    rawTamper.publicationSha256 = canonicalSha256(
      rawCore,
      "providerQualificationPublication",
    );
    expect(() => reverifyProviderQualificationPublication(rawTamper)).toThrow(
      /signature is invalid/,
    );

    expect(() =>
      assembleProviderQualificationPublication({
        artifact: publication.qualificationArtifact,
        cleanupProof: publication.cleanupProof,
        cleanupPublicKeyPem: publicPem(cleanup.publicKey),
        createdAtIso: PUBLICATION_CREATED,
      }),
    ).toThrow(/invalid or cross-run proof/);
  });

  it("rejects a freshly generated self-declared cleanup signer", () => {
    const qualificationArtifact = artifact([
      authority.publicKey,
      observer.publicKey,
      judge.publicKey,
    ]);
    const proof = cleanupProof({
      artifact: qualificationArtifact,
      privateKey: cleanup.privateKey,
      publicKey: cleanup.publicKey,
    });
    expect(() =>
      assembleProviderQualificationPublication({
        artifact: qualificationArtifact,
        cleanupProof: proof,
        cleanupPublicKeyPem: publicPem(cleanup.publicKey),
        createdAtIso: PUBLICATION_CREATED,
      }),
    ).toThrow(/not an exact manifest-authorized observer signer/);
  });
});
