import { describe, expect, it, vi } from "vitest";
import {
  HttpTeeKeyReleaseClient,
  LocalTeeKeyReleaseClient,
} from "./tee-key-release.ts";

const masterSecretHex = "11".repeat(32);

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
        evidence: { measurements?: { agent?: string } };
      };
      expect(body.evidence.measurements?.agent).toBe("sha256:abc");
      return Response.json({
        keyId: body.keyId,
        keyMaterialHex: "a".repeat(64),
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
      keyMaterialHex: "a".repeat(64),
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
