/**
 * Exercises the provider service host as a real protocol boundary with
 * canonical HTTP requests, durable replay state, and actual Ed25519 signing.
 * Provider calls remain deterministic adapters; no result is provider evidence.
 */

import {
  createHash,
  generateKeyPairSync,
  sign as signBytes,
} from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  PROVIDER_CLEANUP_PROOF_SCHEMA,
  verifyProviderCleanupProof,
} from "./controller-orchestrator-bridge.ts";
import {
  canonicalJson,
  canonicalJsonValue,
  canonicalSha256,
} from "./manifest.ts";
import {
  createFileProviderServiceStateStore,
  createInMemoryProviderServiceStateStore,
  createProviderCanaryServiceHost,
  createProviderServiceAuthorizationGrant,
  createStaticProviderServiceRoleAuthorizer,
  DEFAULT_PROVIDER_SECRET_PATH,
  DEFAULT_PROVIDER_SERVICE_PATH,
  PROVIDER_CLEANUP_RESULT_SCHEMA,
  type ProviderCanaryServiceHost,
  type ProviderServiceCorrelation,
  type ProviderServiceEd25519Signer,
  type ProviderServiceRole,
} from "./provider-service-host.ts";
import {
  PROVIDER_OBSERVER_EVIDENCE_SCHEMA,
  type ProviderObserverEvidencePayload,
  providerObserverKeyId,
  SEMANTIC_JUDGE_EVIDENCE_SCHEMA,
  type SemanticJudgeEvidencePayload,
} from "./qualification.ts";
import {
  REFERENCE_OPERATOR_SECRET_REQUEST_SCHEMA,
  REFERENCE_OPERATOR_SERVICE_REQUEST_SCHEMA,
} from "./reference-operator-bundle.ts";
import {
  createProviderObserverSignerClient,
  createSemanticJudgeSignerClient,
  remoteEvidenceSignerIdentitySha256,
} from "./remote-evidence-signer-client.ts";

const NOW = "2026-08-20T18:00:00.000Z";
const EXPIRES = "2026-08-20T18:04:00.000Z";
const HASH = "a".repeat(64);
const TRAJECTORY_HASH = "b".repeat(64);
const RUNNER_HASH = "c".repeat(64);
const TOKEN = "test-token-value-at-least-sixteen";
const TOKEN_SHA256 = createHash("sha256").update(TOKEN).digest("hex");
const CORRELATION = {
  manifestSha256: HASH,
  runId: "run-service-host-001",
  scenarioId: "provider.gmail.confirmed-send",
  operationKind: "gmail.email-send",
} as const satisfies ProviderServiceCorrelation;

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function policy(role: ProviderServiceRole) {
  return {
    role,
    ...CORRELATION,
    notBeforeIso: NOW,
    expiresAtIso: EXPIRES,
  } as const;
}

function serviceRequest(role: string, payload: unknown, requestNonce: string) {
  return {
    schema: REFERENCE_OPERATOR_SERVICE_REQUEST_SCHEMA,
    role,
    requestNonce,
    ...CORRELATION,
    payload,
  };
}

function post(host: ProviderCanaryServiceHost, body: unknown, token = TOKEN) {
  return host.handle(
    new Request(`https://controller.example${DEFAULT_PROVIDER_SERVICE_PATH}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: canonicalJson(canonicalJsonValue(body, "testRequest")),
    }),
  );
}

function signerFixture(): {
  signer: ProviderServiceEd25519Signer;
  publicKeyPem: string;
} {
  const pair = generateKeyPairSync("ed25519");
  const publicKeyPem = pair.publicKey.export({
    type: "spki",
    format: "pem",
  }) as string;
  return {
    publicKeyPem,
    signer: Object.freeze({
      keyId: providerObserverKeyId(publicKeyPem),
      publicKeyPem,
      async sign({
        bytes,
      }: Parameters<ProviderServiceEd25519Signer["sign"]>[0]) {
        return signBytes(null, bytes, pair.privateKey).toString("base64url");
      },
    }),
  };
}

describe("provider canary service host", () => {
  test("executes one exactly authorized controller request and durably refuses its replay", async () => {
    const execute = vi.fn(async (_context, payload) => ({
      accepted: true,
      payload,
    }));
    const host = createProviderCanaryServiceHost({
      authorizer: createStaticProviderServiceRoleAuthorizer([
        {
          bearerTokenSha256: TOKEN_SHA256,
          policy: policy("controller-execute"),
        },
      ]),
      stateStore: createInMemoryProviderServiceStateStore(),
      controller: { execute },
      now: () => new Date(NOW),
    });
    const body = serviceRequest(
      "controller-execute",
      { targetSha256: "d".repeat(64) },
      "A".repeat(32),
    );
    const first = await post(host, body);
    expect(first.status).toBe(200);
    const response = await first.json();
    expect(response).toMatchObject({
      role: "controller-execute",
      requestNonce: "A".repeat(32),
      requestSha256: canonicalSha256(body, "request"),
      result: { accepted: true },
    });
    const replay = await post(host, body);
    expect(replay.status).toBe(409);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  test("rejects an authorizer grant bound to another credential or request digest", async () => {
    const execute = vi.fn();
    const body = serviceRequest("controller-execute", {}, "B".repeat(32));
    const wrongGrant = createProviderServiceAuthorizationGrant({
      ...policy("controller-execute"),
      bearerTokenSha256: "f".repeat(64),
      requestSha256: "e".repeat(64),
      requestNonce: "Z".repeat(32),
    });
    const host = createProviderCanaryServiceHost({
      authorizer: {
        async authorize() {
          return wrongGrant;
        },
      },
      stateStore: createInMemoryProviderServiceStateStore(),
      controller: { execute },
      now: () => new Date(NOW),
    });
    expect((await post(host, body)).status).toBe(403);
    expect(execute).not.toHaveBeenCalled();
  });

  test("never reflects an adapter secret in its fixed error response", async () => {
    const host = createProviderCanaryServiceHost({
      authorizer: createStaticProviderServiceRoleAuthorizer([
        {
          bearerTokenSha256: TOKEN_SHA256,
          policy: policy("controller-execute"),
        },
      ]),
      stateStore: createInMemoryProviderServiceStateStore(),
      controller: {
        async execute() {
          throw new Error("provider-secret-refresh-token");
        },
      },
      now: () => new Date(NOW),
    });
    const response = await post(
      host,
      serviceRequest("controller-execute", {}, "C".repeat(32)),
    );
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(
      "provider-secret-refresh-token",
    );
  });

  test("observer signer refuses before completion and signs only its exact recorded material", async () => {
    const { signer, publicKeyPem } = signerFixture();
    const endpoint = `https://observer.example${DEFAULT_PROVIDER_SERVICE_PATH}`;
    const material = Object.freeze({
      observerProvenance: [],
      observations: [],
      connectorBindings: [],
      failureProbeObservations: [],
      stageReferences: [],
      providerEffectAssurances: [],
    });
    const validation = vi.fn(async ({ expectedValidationSha256 }) => ({
      validationSha256: expectedValidationSha256,
    }));
    const host = createProviderCanaryServiceHost({
      authorizer: createStaticProviderServiceRoleAuthorizer(
        (["observer-begin", "observer-complete", "observer-sign"] as const).map(
          (role) => ({ bearerTokenSha256: TOKEN_SHA256, policy: policy(role) }),
        ),
      ),
      stateStore: createInMemoryProviderServiceStateStore(),
      observer: {
        endpoint,
        organizationId: "independent-observer.example",
        signer,
        adapter: {
          async begin() {
            return {
              sessionId: "observer-session-001",
              correlationSha256: HASH,
            };
          },
          async complete() {
            return material;
          },
          validateEvidenceForSigning: validation,
          async validateCleanupForSigning() {
            throw new Error("cleanup validation is not used in this test");
          },
        },
      },
      now: () => new Date(NOW),
    });
    const fetchImpl: typeof fetch = async (request, init) =>
      host.handle(new Request(request, init));
    const client = createProviderObserverSignerClient({
      pin: {
        role: "observer",
        endpoint,
        organizationId: "independent-observer.example",
        publicKeyPem,
        keyId: signer.keyId,
        serviceIdentitySha256: remoteEvidenceSignerIdentitySha256({
          role: "observer",
          endpoint,
          organizationId: "independent-observer.example",
          keyId: signer.keyId,
        }),
      },
      bearerToken: TOKEN,
      fetchImpl,
      now: () => new Date(NOW),
    });
    const evidence: ProviderObserverEvidencePayload = {
      schema: PROVIDER_OBSERVER_EVIDENCE_SCHEMA,
      manifestSha256: HASH,
      runId: CORRELATION.runId,
      runNonce: "run-nonce-001",
      scenarioId: CORRELATION.scenarioId,
      scenarioStartedAtIso: "2026-08-20T17:59:00.000Z",
      scenarioEndedAtIso: "2026-08-20T17:59:30.000Z",
      trajectoryVerifiedAtIso: "2026-08-20T17:59:40.000Z",
      signedAtIso: NOW,
      trajectorySetSha256: TRAJECTORY_HASH,
      runnerResultSha256: RUNNER_HASH,
      ...material,
    };
    await expect(client.sign(evidence)).rejects.toThrow(
      "service returned HTTP 403",
    );

    const session = {
      sessionId: "observer-session-001",
      correlationSha256: HASH,
    };
    expect(
      (await post(host, serviceRequest("observer-begin", {}, "D".repeat(32))))
        .status,
    ).toBe(200);
    expect(
      (
        await post(
          host,
          serviceRequest("observer-complete", { session }, "E".repeat(32)),
        )
      ).status,
    ).toBe(200);
    const signed = await client.sign(evidence);
    expect(signed.keyId).toBe(signer.keyId);
    expect(signed.payload).toEqual(evidence);
    expect(validation).toHaveBeenCalledTimes(1);

    await expect(
      client.sign({
        ...evidence,
        observations: [{ substituted: true }] as never,
      }),
    ).rejects.toThrow("service returned HTTP 403");
  });

  test("semantic judge cannot sign verdicts other than its recorded evaluation", async () => {
    const { signer, publicKeyPem } = signerFixture();
    const endpoint = `https://judge.example${DEFAULT_PROVIDER_SERVICE_PATH}`;
    const verdicts = [
      {
        criterionId: "criterion-1",
        rubricSha256: "d".repeat(64),
        status: "passed" as const,
        score: 1,
        requestSha256: "e".repeat(64),
        responseSha256: "f".repeat(64),
      },
    ];
    const host = createProviderCanaryServiceHost({
      authorizer: createStaticProviderServiceRoleAuthorizer(
        (["semantic-judge-evaluate", "semantic-judge-sign"] as const).map(
          (role) => ({ bearerTokenSha256: TOKEN_SHA256, policy: policy(role) }),
        ),
      ),
      stateStore: createInMemoryProviderServiceStateStore(),
      semanticJudge: {
        endpoint,
        organizationId: "independent-judge.example",
        signer,
        adapter: {
          async evaluate() {
            return verdicts;
          },
          async validateEvidenceForSigning({ expectedValidationSha256 }) {
            return { validationSha256: expectedValidationSha256 };
          },
        },
      },
      now: () => new Date(NOW),
    });
    expect(
      (
        await post(
          host,
          serviceRequest("semantic-judge-evaluate", {}, "F".repeat(32)),
        )
      ).status,
    ).toBe(200);
    const fetchImpl: typeof fetch = async (request, init) =>
      host.handle(new Request(request, init));
    const client = createSemanticJudgeSignerClient({
      pin: {
        role: "semantic-judge",
        endpoint,
        organizationId: "independent-judge.example",
        publicKeyPem,
        keyId: signer.keyId,
        serviceIdentitySha256: remoteEvidenceSignerIdentitySha256({
          role: "semantic-judge",
          endpoint,
          organizationId: "independent-judge.example",
          keyId: signer.keyId,
        }),
      },
      bearerToken: TOKEN,
      fetchImpl,
      now: () => new Date(NOW),
    });
    const payload: SemanticJudgeEvidencePayload = {
      schema: SEMANTIC_JUDGE_EVIDENCE_SCHEMA,
      manifestSha256: HASH,
      runId: CORRELATION.runId,
      runNonce: "run-nonce-001",
      scenarioId: CORRELATION.scenarioId,
      scenarioEndedAtIso: "2026-08-20T17:59:30.000Z",
      trajectoryVerifiedAtIso: "2026-08-20T17:59:40.000Z",
      signedAtIso: NOW,
      trajectorySetSha256: TRAJECTORY_HASH,
      actingAdapter: "adapter",
      actingProvider: "provider",
      actingModel: "acting-model",
      judgeProvider: "independent-provider",
      judgeModel: "judge-model",
      verdicts,
    };
    expect((await client.sign(payload)).payload.verdicts).toEqual(verdicts);
    await expect(
      client.sign({ ...payload, verdicts: [{ ...verdicts[0], score: 0.5 }] }),
    ).rejects.toThrow("service returned HTTP 403");
  });

  test("cleanup service returns unsigned state and only the observer can validate and sign it", async () => {
    const { signer, publicKeyPem } = signerFixture();
    const cleanupResult = {
      schema: PROVIDER_CLEANUP_RESULT_SCHEMA,
      ...CORRELATION,
      runNonce: "run-nonce-001",
      cleanupScopeSha256: "d".repeat(64),
      rawControllerMaterialSha256: "e".repeat(64),
      qualificationArtifactSha256: "f".repeat(64),
      completedStagesSha256: "1".repeat(64),
      failed: false,
      disposition: "cleaned" as const,
      completedAtIso: NOW,
      cleanupReceiptSha256: "2".repeat(64),
    };
    const cleanupHost = createProviderCanaryServiceHost({
      authorizer: createStaticProviderServiceRoleAuthorizer([
        {
          bearerTokenSha256: TOKEN_SHA256,
          policy: policy("cleanup-execute"),
        },
      ]),
      stateStore: createInMemoryProviderServiceStateStore(),
      cleanup: {
        async executeCleanup() {
          return cleanupResult;
        },
      },
      now: () => new Date(NOW),
    });
    const cleanupResponse = await post(
      cleanupHost,
      serviceRequest("cleanup-execute", {}, "I".repeat(32)),
    );
    expect(cleanupResponse.status).toBe(200);
    const cleanupEnvelope = await cleanupResponse.json();
    expect(cleanupEnvelope.result).toEqual(cleanupResult);
    expect(cleanupEnvelope.result).not.toHaveProperty("signature");

    const observerHost = createProviderCanaryServiceHost({
      authorizer: createStaticProviderServiceRoleAuthorizer([
        {
          bearerTokenSha256: TOKEN_SHA256,
          policy: policy("observer-cleanup-sign"),
        },
      ]),
      stateStore: createInMemoryProviderServiceStateStore(),
      observer: {
        endpoint: `https://observer.example${DEFAULT_PROVIDER_SERVICE_PATH}`,
        organizationId: "independent-observer.example",
        signer,
        adapter: {
          async begin() {
            throw new Error("not used");
          },
          async complete() {
            throw new Error("not used");
          },
          async validateEvidenceForSigning() {
            throw new Error("not used");
          },
          async validateCleanupForSigning({
            cleanupResult: observed,
            expectedValidationSha256,
          }) {
            expect(observed.cleanupReceiptSha256).toBe(
              cleanupResult.cleanupReceiptSha256,
            );
            return {
              validationSha256: expectedValidationSha256,
              payload: {
                schema: PROVIDER_CLEANUP_PROOF_SCHEMA,
                scenarioId: CORRELATION.scenarioId,
                runId: observed.runId,
                runNonce: observed.runNonce,
                manifestSha256: observed.manifestSha256,
                cleanupScopeSha256: observed.cleanupScopeSha256,
                rawControllerMaterialSha256:
                  observed.rawControllerMaterialSha256,
                qualificationArtifactSha256:
                  observed.qualificationArtifactSha256,
                disposition: observed.disposition,
                completedAtIso: observed.completedAtIso,
              },
            };
          },
        },
      },
      now: () => new Date(NOW),
    });
    const signedResponse = await post(
      observerHost,
      serviceRequest(
        "observer-cleanup-sign",
        { cleanupResult: cleanupEnvelope.result },
        "J".repeat(32),
      ),
    );
    expect(signedResponse.status).toBe(200);
    const signedEnvelope = await signedResponse.json();
    expect(
      verifyProviderCleanupProof({
        proof: signedEnvelope.result,
        pinnedPublicKeysPem: [publicKeyPem],
        expected: {
          scenarioId: CORRELATION.scenarioId,
          runId: CORRELATION.runId,
          runNonce: cleanupResult.runNonce,
          manifestSha256: HASH,
          cleanupScopeSha256: cleanupResult.cleanupScopeSha256,
          rawControllerMaterialSha256:
            cleanupResult.rawControllerMaterialSha256,
          qualificationArtifactSha256:
            cleanupResult.qualificationArtifactSha256,
          scenarioEndedAtIso: "2026-08-20T17:59:30.000Z",
          keyId: signer.keyId,
        },
        now: new Date(NOW),
      }).keyId,
    ).toBe(signer.keyId);
  });

  test("secret broker resolves only the grant's exact sorted refs and rejects replay", async () => {
    const secretRefs = ["controller/bearer", "observer/bearer"] as const;
    const host = createProviderCanaryServiceHost({
      authorizer: createStaticProviderServiceRoleAuthorizer([
        {
          bearerTokenSha256: TOKEN_SHA256,
          policy: {
            role: "secret-resolve",
            allowedSecretRefs: secretRefs,
            notBeforeIso: NOW,
            expiresAtIso: EXPIRES,
          },
        },
      ]),
      stateStore: createInMemoryProviderServiceStateStore(),
      secretBroker: {
        async resolve() {
          return {
            "controller/bearer": "resolved-controller-value",
            "observer/bearer": "resolved-observer-value",
          };
        },
      },
      now: () => new Date(NOW),
    });
    const body = {
      schema: REFERENCE_OPERATOR_SECRET_REQUEST_SCHEMA,
      requestNonce: "G".repeat(32),
      secretRefs,
    };
    const request = () =>
      host.handle(
        new Request(`https://broker.example${DEFAULT_PROVIDER_SECRET_PATH}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${TOKEN}`,
            "Content-Type": "application/json",
          },
          body: canonicalJson(canonicalJsonValue(body, "secretRequest")),
        }),
      );
    expect((await request()).status).toBe(200);
    expect((await request()).status).toBe(409);
  });

  test("filesystem store survives restart, protects modes, and refuses a symlink namespace", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "provider-host-state-"));
    temporaryDirectories.push(directory);
    chmodSync(directory, 0o700);
    const first = createFileProviderServiceStateStore(directory);
    expect(
      await first.claimReplay({
        namespace: "controller:grant",
        nonce: "H".repeat(32),
        requestSha256: HASH,
        expiresAtIso: EXPIRES,
      }),
    ).toBe(true);
    expect(await first.putOnce("proof", { status: "recorded" })).toBe(true);
    const second = createFileProviderServiceStateStore(directory);
    expect(
      await second.claimReplay({
        namespace: "controller:grant",
        nonce: "H".repeat(32),
        requestSha256: HASH,
        expiresAtIso: EXPIRES,
      }),
    ).toBe(false);
    expect(await second.get("proof")).toEqual({ status: "recorded" });
    const namespace = path.join(directory, "provider-service-v1");
    expect(lstatSync(namespace).mode & 0o077).toBe(0);

    const linkedRoot = mkdtempSync(path.join(tmpdir(), "provider-host-link-"));
    temporaryDirectories.push(linkedRoot);
    chmodSync(linkedRoot, 0o700);
    symlinkSync(namespace, path.join(linkedRoot, "provider-service-v1"));
    expect(readlinkSync(path.join(linkedRoot, "provider-service-v1"))).toBe(
      namespace,
    );
    expect(() => createFileProviderServiceStateStore(linkedRoot)).toThrow();
  });
});
