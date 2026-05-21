import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  HttpTeeKeyReleaseClient,
  LocalTeeKeyReleaseClient,
  wrapTeeReleaseKey,
} from "./tee-key-release.ts";

const masterSecretHex = "11".repeat(32);
const releasedKeyHex = "a".repeat(64);

describe("TEE key release", () => {
  it("derives key material only after evidence satisfies policy", async () => {
    const client = new LocalTeeKeyReleaseClient({
      masterSecretHex,
      evidenceProvider: {
        id: "fixture",
        collectEvidence: async () => evidence({ agent: "sha256:abc" }),
      },
    });

    await expect(
      client.releaseKey({
        keyId: "agent-session",
        context: "wallet",
        policy: {
          required: true,
          allowedKinds: ["dstack"],
          expectedNonce: "nonce-1",
          requiredMeasurements: {
            agent: "abc",
            policy: "sha256:def",
          },
          requiredClaims: {
            debugDisabled: true,
            secureBoot: true,
          },
        },
      }),
    ).resolves.toMatchObject({
      keyId: "agent-session",
      keyMaterialHex: expect.stringMatching(/^[a-f0-9]{64}$/),
      decision: { trusted: true, reason: "allowed" },
    });
  });

  it("rejects release when the verifier nonce does not match", async () => {
    const client = new LocalTeeKeyReleaseClient({
      masterSecretHex,
      evidenceProvider: {
        id: "fixture",
        collectEvidence: async () => evidence({ agent: "sha256:abc" }),
      },
    });

    await expect(
      client.releaseKey({
        keyId: "agent-session",
        policy: {
          required: true,
          expectedNonce: "wrong",
        },
      }),
    ).rejects.toThrow(/TEE key release rejected evidence/);
  });

  it("binds derived key material to agent and policy measurements", async () => {
    const first = new LocalTeeKeyReleaseClient({
      masterSecretHex,
      evidenceProvider: {
        id: "fixture-a",
        collectEvidence: async () => evidence({ agent: "sha256:aaa" }),
      },
    });
    const second = new LocalTeeKeyReleaseClient({
      masterSecretHex,
      evidenceProvider: {
        id: "fixture-b",
        collectEvidence: async () => evidence({ agent: "sha256:bbb" }),
      },
    });

    const request = {
      keyId: "model-key",
      policy: { required: true, allowedKinds: ["dstack"] },
    };
    const firstKey = await first.releaseKey(request);
    const secondKey = await second.releaseKey(request);

    expect(firstKey.keyMaterialHex).not.toBe(secondKey.keyMaterialHex);
  });

  it("posts evidence to an HTTP verifier/KMS and returns approved key material", async () => {
    const request = vi.fn(async (_url: URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        keyId: string;
        nonce: string;
        ephemeralPublicKey: string;
        reportData: string;
        evidence: { measurements?: { agent?: string } };
      };
      expect(body.evidence.measurements?.agent).toBe("sha256:abc");
      // The client must bind a fresh nonce + ephemeral public key + report_data.
      expect(body.nonce).toMatch(/^[a-f0-9]{64}$/);
      expect(body.ephemeralPublicKey.length).toBeGreaterThan(0);
      expect(body.reportData).toMatch(/^[a-f0-9]{64}$/);
      // The KMS wraps the key to the agent's ephemeral public key.
      return Response.json({
        keyId: body.keyId,
        wrappedKey: wrapTeeReleaseKey({
          keyMaterialHex: releasedKeyHex,
          agentEphemeralPublicKeyDerBase64: body.ephemeralPublicKey,
          nonceHex: body.nonce,
        }),
        nonce: body.nonce,
        decision: { trusted: true, reason: "allowed" },
      });
    });
    const client = new HttpTeeKeyReleaseClient({
      baseUrl: "https://kms.example.test",
      fetch: request as unknown as typeof fetch,
      token: "kms-token",
      evidenceProvider: {
        id: "fixture",
        collectEvidence: async () => evidence({ agent: "sha256:abc" }),
      },
    });

    await expect(
      client.releaseKey({
        keyId: "agent-session",
        policy: { required: true },
      }),
    ).resolves.toMatchObject({
      keyId: "agent-session",
      keyMaterialHex: releasedKeyHex,
      decision: { trusted: true },
    });
    expect(request).toHaveBeenCalledWith(
      new URL("https://kms.example.test/v1/tee/key-release"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer kms-token",
        }),
      }),
    );
  });

  it("rejects an HTTP verifier/KMS denial without returning key material", async () => {
    const client = new HttpTeeKeyReleaseClient({
      baseUrl: "https://kms.example.test",
      fetch: vi.fn(async () =>
        Response.json(
          {
            decision: {
              trusted: false,
              reason: "measurement-mismatch",
              detail: "bad agent digest",
            },
          },
          { status: 403 },
        ),
      ) as unknown as typeof fetch,
      evidenceProvider: {
        id: "fixture",
        collectEvidence: async () => evidence({ agent: "sha256:bad" }),
      },
    });

    await expect(
      client.releaseKey({
        keyId: "agent-session",
        policy: { required: true },
      }),
    ).rejects.toThrow(/bad agent digest/);
  });

  it("rejects a response that does not echo the request nonce (replay defense)", async () => {
    const client = new HttpTeeKeyReleaseClient({
      baseUrl: "https://kms.example.test",
      // KMS echoes a stale/forged nonce instead of the one the client issued.
      fetch: vi.fn(async () =>
        Response.json({
          keyId: "agent-session",
          keyMaterialHex: "a".repeat(64),
          nonce: "replayed-nonce",
          decision: { trusted: true, reason: "allowed" },
        }),
      ) as unknown as typeof fetch,
      evidenceProvider: {
        id: "fixture",
        collectEvidence: async () => evidence({ agent: "sha256:abc" }),
      },
    });

    await expect(
      client.releaseKey({ keyId: "agent-session", policy: { required: true } }),
    ).rejects.toThrow(/did not echo the request nonce/);
  });

  it("rejects evidence whose report_data is not bound to the issued nonce/epk", async () => {
    const client = new HttpTeeKeyReleaseClient({
      baseUrl: "https://kms.example.test",
      fetch: vi.fn(async (_url: URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { nonce: string };
        return Response.json({
          keyId: "agent-session",
          keyMaterialHex: "a".repeat(64),
          nonce: body.nonce,
          decision: { trusted: true, reason: "allowed" },
        });
      }) as unknown as typeof fetch,
      evidenceProvider: {
        id: "fixture",
        collectEvidence: async () => evidence({ agent: "sha256:abc" }),
        // A report_data-aware provider that lies: it returns a fixed,
        // attacker-controlled report_data instead of binding the issued value.
        collectEvidenceWithReportData: async ({ nonce: bound }) => ({
          ...evidence({ agent: "sha256:abc" }),
          freshness: { nonce: bound, timestamp: "2026-05-20T00:00:00.000Z" },
          reportData: "deadbeef".repeat(8),
        }),
      },
    });

    await expect(
      client.releaseKey({ keyId: "agent-session", policy: { required: true } }),
    ).rejects.toThrow(/report_data is not bound/);
  });

  it("rejects a key wrapped to a different ephemeral public key (binding forgery)", async () => {
    const client = new HttpTeeKeyReleaseClient({
      baseUrl: "https://kms.example.test",
      // KMS wraps the key to an attacker-chosen epk, not the one the client
      // sent. The ECDH shared secret differs, so the AEAD tag check fails.
      fetch: vi.fn(async (_url: URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { nonce: string };
        const { publicKey } = generateKeyPairSync("x25519");
        const foreignEpk = publicKey
          .export({ type: "spki", format: "der" })
          .toString("base64");
        return Response.json({
          keyId: "agent-session",
          wrappedKey: wrapTeeReleaseKey({
            keyMaterialHex: releasedKeyHex,
            agentEphemeralPublicKeyDerBase64: foreignEpk,
            nonceHex: body.nonce,
          }),
          nonce: body.nonce,
          decision: { trusted: true, reason: "allowed" },
        });
      }) as unknown as typeof fetch,
      evidenceProvider: {
        id: "fixture",
        collectEvidence: async () => evidence({ agent: "sha256:abc" }),
      },
    });

    await expect(
      client.releaseKey({ keyId: "agent-session", policy: { required: true } }),
    ).rejects.toThrow();
  });

  it("refuses a plain-http KMS URL under the production profile", () => {
    expect(
      () =>
        new HttpTeeKeyReleaseClient({
          baseUrl: "http://kms.example.test",
          requireSecureTransport: true,
          evidenceProvider: {
            id: "fixture",
            collectEvidence: async () => evidence({ agent: "sha256:abc" }),
          },
        }),
    ).toThrow(/https:\/RA-TLS KMS URL under the production profile/);
  });

  it("refuses NODE_TLS_REJECT_UNAUTHORIZED=0 under the production profile", () => {
    expect(
      () =>
        new HttpTeeKeyReleaseClient({
          baseUrl: "https://kms.example.test",
          requireSecureTransport: true,
          env: { NODE_TLS_REJECT_UNAUTHORIZED: "0" },
          evidenceProvider: {
            id: "fixture",
            collectEvidence: async () => evidence({ agent: "sha256:abc" }),
          },
        }),
    ).toThrow(/NODE_TLS_REJECT_UNAUTHORIZED=0/);
  });
});

function evidence(overrides: { agent: string }) {
  return {
    kind: "dstack",
    measurements: {
      agent: overrides.agent,
      policy: "sha256:def",
      device: "sha256:device",
    },
    freshness: {
      nonce: "nonce-1",
      timestamp: "2026-05-20T00:00:00.000Z",
    },
    claims: {
      debugDisabled: true,
      secureBoot: true,
    },
  };
}
