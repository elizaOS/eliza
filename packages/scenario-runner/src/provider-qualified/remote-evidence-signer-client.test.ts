/**
 * Exercises the remote evidence signer boundary with ephemeral real Ed25519
 * keys and adversarial in-memory HTTP responses; no external signer is implied.
 */

import {
  createHash,
  generateKeyPairSync,
  type KeyObject,
  sign,
} from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson, canonicalJsonValue } from "./manifest.ts";
import {
  PROVIDER_OBSERVER_EVIDENCE_SCHEMA,
  type ProviderObserverEvidencePayload,
  providerEvidenceSigningBytes,
  providerObserverKeyId,
  SEMANTIC_JUDGE_EVIDENCE_SCHEMA,
  type SemanticJudgeEvidencePayload,
  semanticEvidenceSigningBytes,
} from "./qualification.ts";
import {
  createProviderObserverSignerClient,
  createSemanticJudgeSignerClient,
  preflightIndependentEvidenceSigners,
  REMOTE_EVIDENCE_SIGN_RESPONSE_SCHEMA,
  type RemoteEvidenceSignerPin,
  type RemoteEvidenceSignerRole,
  remoteEvidenceSignerIdentitySha256,
} from "./remote-evidence-signer-client.ts";

const HASH = "a".repeat(64);
const NOW = new Date("2026-08-20T12:00:00.000Z");
const TOKEN = "operator-secret-bearer-value";

function keyMaterial(
  role: RemoteEvidenceSignerRole,
  endpoint: string,
  organizationId: string,
) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey
    .export({ type: "spki", format: "pem" })
    .toString();
  const keyId = providerObserverKeyId(publicKeyPem);
  const pin: RemoteEvidenceSignerPin = {
    role,
    endpoint,
    organizationId,
    publicKeyPem,
    keyId,
    serviceIdentitySha256: remoteEvidenceSignerIdentitySha256({
      role,
      endpoint,
      organizationId,
      keyId,
    }),
  };
  return { privateKey, pin };
}

function observerPayload(): ProviderObserverEvidencePayload {
  return {
    schema: PROVIDER_OBSERVER_EVIDENCE_SCHEMA,
    manifestSha256: HASH,
    runId: "run-123",
    runNonce: "run-nonce-1234567890",
    scenarioId: "scenario-123",
    scenarioStartedAtIso: "2026-08-20T11:59:00.000Z",
    scenarioEndedAtIso: "2026-08-20T11:59:50.000Z",
    trajectoryVerifiedAtIso: "2026-08-20T11:59:55.000Z",
    signedAtIso: NOW.toISOString(),
    trajectorySetSha256: HASH,
    runnerResultSha256: "b".repeat(64),
    observerProvenance: [],
    observations: [],
    connectorBindings: [],
    failureProbeObservations: [],
    stageReferences: [],
    providerEffectAssurances: [],
  };
}

function judgePayload(): SemanticJudgeEvidencePayload {
  return {
    schema: SEMANTIC_JUDGE_EVIDENCE_SCHEMA,
    manifestSha256: HASH,
    runId: "run-123",
    runNonce: "run-nonce-1234567890",
    scenarioId: "scenario-123",
    scenarioEndedAtIso: "2026-08-20T11:59:50.000Z",
    trajectoryVerifiedAtIso: "2026-08-20T11:59:55.000Z",
    signedAtIso: NOW.toISOString(),
    trajectorySetSha256: HASH,
    actingAdapter: "live-adapter",
    actingProvider: "acting-provider",
    actingModel: "acting-model",
    judgeProvider: "independent-provider",
    judgeModel: "judge-model",
    verdicts: [],
  };
}

function successfulFetch(input: {
  pin: RemoteEvidenceSignerPin;
  privateKey: KeyObject;
  mutate?: (
    response: Record<string, unknown>,
    request: Record<string, unknown>,
  ) => void;
  assertRequest?: (request: Record<string, unknown>, init: RequestInit) => void;
}): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = String(init?.body);
    const request = JSON.parse(body) as Record<string, unknown>;
    input.assertRequest?.(request, init ?? {});
    const payloadBytes = Buffer.from(
      String(request.payloadCanonicalBase64url),
      "base64url",
    );
    const payload = JSON.parse(payloadBytes.toString("utf8")) as Record<
      string,
      unknown
    >;
    const signature = sign(null, payloadBytes, input.privateKey).toString(
      "base64url",
    );
    const response: Record<string, unknown> = {
      schema: REMOTE_EVIDENCE_SIGN_RESPONSE_SCHEMA,
      role: input.pin.role,
      serviceIdentitySha256: input.pin.serviceIdentitySha256,
      requestNonce: request.requestNonce,
      requestSha256: createHash("sha256").update(body, "utf8").digest("hex"),
      payloadSha256: request.payloadSha256,
      respondedAtIso: NOW.toISOString(),
      keyId: input.pin.keyId,
      signature,
      signedEnvelope: { keyId: input.pin.keyId, payload, signature },
    };
    input.mutate?.(response, request);
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

describe("remote evidence signer clients", () => {
  it("sends a credential only in Authorization and verifies an exact observer envelope", async () => {
    const material = keyMaterial(
      "observer",
      "https://observer.example.test/v1/sign",
      "observer-org",
    );
    const payload = observerPayload();
    const client = createProviderObserverSignerClient({
      pin: material.pin,
      bearerToken: TOKEN,
      now: () => NOW,
      fetchImpl: successfulFetch({
        ...material,
        assertRequest(request, init) {
          expect(init.redirect).toBe("manual");
          expect(new Headers(init.headers).get("authorization")).toBe(
            `Bearer ${TOKEN}`,
          );
          expect(JSON.stringify(request)).not.toContain(TOKEN);
          expect(
            Buffer.from(String(request.payloadCanonicalBase64url), "base64url"),
          ).toEqual(providerEvidenceSigningBytes(payload));
          expect(request).toMatchObject({
            manifestSha256: payload.manifestSha256,
            runId: payload.runId,
            runNonce: payload.runNonce,
            scenarioId: payload.scenarioId,
            trajectorySetSha256: payload.trajectorySetSha256,
          });
          expect(String(request.requestNonce)).toMatch(/^[A-Za-z0-9_-]{43}$/);
        },
      }),
    });
    const envelope = await client.sign(payload);
    expect(envelope.payload).toEqual(payload);
    expect(envelope.keyId).toBe(material.pin.keyId);
  });

  it("uses a distinct semantic client and verifies its exact signed bytes", async () => {
    const material = keyMaterial(
      "semantic-judge",
      "https://judge.example.test/sign",
      "judge-org",
    );
    const payload = judgePayload();
    const client = createSemanticJudgeSignerClient({
      pin: material.pin,
      bearerToken: TOKEN,
      now: () => NOW,
      fetchImpl: successfulFetch({
        ...material,
        assertRequest(request) {
          expect(
            Buffer.from(String(request.payloadCanonicalBase64url), "base64url"),
          ).toEqual(semanticEvidenceSigningBytes(payload));
        },
      }),
    });
    await expect(client.sign(payload)).resolves.toMatchObject({ payload });
  });

  it("rejects redirects without following them", async () => {
    const material = keyMaterial(
      "observer",
      "https://observer.example.test/sign",
      "observer-org",
    );
    const client = createProviderObserverSignerClient({
      pin: material.pin,
      bearerToken: TOKEN,
      now: () => NOW,
      fetchImpl: (async () =>
        new Response(null, {
          status: 307,
          headers: { location: "https://evil.test" },
        })) as typeof fetch,
    });
    await expect(client.sign(observerPayload())).rejects.toThrow(
      /redirects are forbidden/,
    );
  });

  it("rejects oversized response bodies before parsing them", async () => {
    const material = keyMaterial(
      "observer",
      "https://observer.example.test/sign",
      "observer-org",
    );
    const client = createProviderObserverSignerClient({
      pin: material.pin,
      bearerToken: TOKEN,
      now: () => NOW,
      fetchImpl: (async () =>
        new Response("x", {
          status: 200,
          headers: {
            "content-type": "application/json",
            "content-length": String(128 * 1024 + 1),
          },
        })) as typeof fetch,
    });
    await expect(client.sign(observerPayload())).rejects.toThrow(
      /exceeds the byte limit/,
    );
  });

  it("rejects stale responses and signed payloads", async () => {
    const material = keyMaterial(
      "observer",
      "https://observer.example.test/sign",
      "observer-org",
    );
    const client = createProviderObserverSignerClient({
      pin: material.pin,
      bearerToken: TOKEN,
      now: () => NOW,
      fetchImpl: successfulFetch({
        ...material,
        mutate(response) {
          response.respondedAtIso = "2026-08-20T11:00:00.000Z";
        },
      }),
    });
    await expect(client.sign(observerPayload())).rejects.toThrow(
      /freshness window/,
    );

    const stalePayload = {
      ...observerPayload(),
      signedAtIso: "2026-08-20T11:00:00.000Z",
    };
    const stalePayloadClient = createProviderObserverSignerClient({
      pin: material.pin,
      bearerToken: TOKEN,
      now: () => NOW,
      fetchImpl: successfulFetch(material),
    });
    await expect(stalePayloadClient.sign(stalePayload)).rejects.toThrow(
      /signed payload is outside the authorized freshness window/,
    );
  });

  it("aborts a request at the configured time bound", async () => {
    const material = keyMaterial(
      "observer",
      "https://observer.example.test/sign",
      "observer-org",
    );
    const hangingFetch = ((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new Error(TOKEN)),
          {
            once: true,
          },
        );
      })) as typeof fetch;
    const client = createProviderObserverSignerClient({
      pin: material.pin,
      bearerToken: TOKEN,
      timeoutMs: 1,
      now: () => NOW,
      fetchImpl: hangingFetch,
    });
    const error = await client
      .sign(observerPayload())
      .catch((caught: unknown) => caught);
    expect(String(error)).toContain("HTTPS request failed");
    expect(String(error)).not.toContain(TOKEN);
  });

  it("rejects a swapped payload even when the response is otherwise correlated", async () => {
    const material = keyMaterial(
      "observer",
      "https://observer.example.test/sign",
      "observer-org",
    );
    const client = createProviderObserverSignerClient({
      pin: material.pin,
      bearerToken: TOKEN,
      now: () => NOW,
      fetchImpl: successfulFetch({
        ...material,
        mutate(response) {
          const envelope = response.signedEnvelope as {
            payload: Record<string, unknown>;
          };
          envelope.payload = {
            ...envelope.payload,
            scenarioId: "swapped-scenario",
          };
        },
      }),
    });
    await expect(client.sign(observerPayload())).rejects.toThrow(
      /exact canonical payload/,
    );
  });

  it("rejects a signature made by an unpinned key", async () => {
    const pinned = keyMaterial(
      "observer",
      "https://observer.example.test/sign",
      "observer-org",
    );
    const attacker = keyMaterial(
      "observer",
      "https://attacker.example.test/sign",
      "attacker-org",
    );
    const client = createProviderObserverSignerClient({
      pin: pinned.pin,
      bearerToken: TOKEN,
      now: () => NOW,
      fetchImpl: successfulFetch({
        pin: pinned.pin,
        privateKey: attacker.privateKey,
      }),
    });
    await expect(client.sign(observerPayload())).rejects.toThrow(
      /signature is invalid/,
    );
  });

  it("never reflects a bearer secret from transport failures", async () => {
    const material = keyMaterial(
      "observer",
      "https://observer.example.test/sign",
      "observer-org",
    );
    const client = createProviderObserverSignerClient({
      pin: material.pin,
      bearerToken: TOKEN,
      now: () => NOW,
      fetchImpl: (async () => {
        throw new Error(`upstream leaked ${TOKEN}`);
      }) as typeof fetch,
    });
    const error = await client
      .sign(observerPayload())
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(TOKEN);
    expect(String(error)).toContain("HTTPS request failed");

    const errorResponseClient = createProviderObserverSignerClient({
      pin: material.pin,
      bearerToken: TOKEN,
      now: () => NOW,
      fetchImpl: (async () =>
        new Response(`upstream diagnostic ${TOKEN}`, {
          status: 500,
          headers: { "content-type": "text/plain" },
        })) as typeof fetch,
    });
    const responseError = await errorResponseClient
      .sign(observerPayload())
      .catch((caught: unknown) => caught);
    expect(String(responseError)).toContain("service returned HTTP 500");
    expect(String(responseError)).not.toContain(TOKEN);
  });

  it("rejects credential-bearing endpoints and private key material", () => {
    const material = keyMaterial(
      "observer",
      "https://observer.example.test/sign",
      "observer-org",
    );
    expect(() =>
      createProviderObserverSignerClient({
        pin: {
          ...material.pin,
          endpoint: "https://user:password@observer.example.test/sign",
        },
        bearerToken: TOKEN,
      }),
    ).toThrow(/credential-free HTTPS/);
    expect(() =>
      createProviderObserverSignerClient({
        pin: {
          ...material.pin,
          publicKeyPem:
            "-----BEGIN PRIVATE KEY-----\nforbidden\n-----END PRIVATE KEY-----",
        },
        bearerToken: TOKEN,
      }),
    ).toThrow(/private key material is forbidden/);
  });

  it("rejects endpoint path substitution against an existing identity pin", () => {
    const material = keyMaterial(
      "observer",
      "https://observer.example.test/v1/sign",
      "observer-org",
    );
    expect(() =>
      createProviderObserverSignerClient({
        pin: {
          ...material.pin,
          endpoint: "https://observer.example.test/v1/admin-sign",
        },
        bearerToken: TOKEN,
      }),
    ).toThrow(/service identity pin does not match/);
  });

  it("rejects a response that completes after the request expiry", async () => {
    const material = keyMaterial(
      "observer",
      "https://observer.example.test/sign",
      "observer-org",
    );
    let clockReads = 0;
    const client = createProviderObserverSignerClient({
      pin: material.pin,
      bearerToken: TOKEN,
      requestTtlMs: 1_000,
      now: () => {
        clockReads += 1;
        return clockReads === 1 ? NOW : new Date(NOW.getTime() + 7_000);
      },
      fetchImpl: successfulFetch(material),
    });
    await expect(client.sign(observerPayload())).rejects.toThrow(
      /arrived after the authorized freshness window/,
    );
  });

  it("preflight rejects a shared origin, organization, or key", () => {
    const observer = keyMaterial(
      "observer",
      "https://shared.example.test/observer",
      "observer-org",
    );
    const sameOriginJudge = keyMaterial(
      "semantic-judge",
      "https://shared.example.test/judge",
      "judge-org",
    );
    expect(() =>
      preflightIndependentEvidenceSigners({
        observer: observer.pin,
        judge: sameOriginJudge.pin,
      }),
    ).toThrow(/origins must be distinct/);

    const judge = keyMaterial(
      "semantic-judge",
      "https://judge.example.test/sign",
      "observer-org",
    );
    expect(() =>
      preflightIndependentEvidenceSigners({
        observer: observer.pin,
        judge: judge.pin,
      }),
    ).toThrow(/organizations must be distinct/);

    const judgeWithObserverKey: RemoteEvidenceSignerPin = {
      ...observer.pin,
      role: "semantic-judge",
      endpoint: "https://judge.example.test/sign",
      organizationId: "judge-org",
      serviceIdentitySha256: remoteEvidenceSignerIdentitySha256({
        role: "semantic-judge",
        endpoint: "https://judge.example.test/sign",
        organizationId: "judge-org",
        keyId: observer.pin.keyId,
      }),
    };
    expect(() =>
      preflightIndependentEvidenceSigners({
        observer: observer.pin,
        judge: judgeWithObserverKey,
      }),
    ).toThrow(/keys must be distinct/);
  });

  it("keeps canonical request material deterministic except for nonce and time", async () => {
    const material = keyMaterial(
      "observer",
      "https://observer.example.test/sign",
      "observer-org",
    );
    let captured = "";
    const fetchImpl = successfulFetch({
      ...material,
      assertRequest(request) {
        captured = canonicalJson(canonicalJsonValue(request, "request"));
      },
    });
    await createProviderObserverSignerClient({
      pin: material.pin,
      bearerToken: TOKEN,
      now: () => NOW,
      fetchImpl,
    }).sign(observerPayload());
    expect(captured).toContain(
      `"payloadSha256":"${createHash("sha256").update(providerEvidenceSigningBytes(observerPayload())).digest("hex")}"`,
    );
  });
});
