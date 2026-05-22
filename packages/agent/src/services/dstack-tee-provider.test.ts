import { describe, expect, it, vi } from "vitest";
import { collectDstackTeeEvidence } from "./dstack-tee-provider.ts";

describe("dstack TEE provider", () => {
  it("collects normalized evidence from inline JSON", async () => {
    await expect(
      collectDstackTeeEvidence({
        env: {
          ELIZA_TEE_EVIDENCE_JSON: JSON.stringify({
            kind: "dstack",
            measurements: { agent: "sha256:abc" },
            freshness: { nonce: "n" },
            claims: { debugDisabled: true },
          }),
        },
      }),
    ).resolves.toMatchObject({
      kind: "dstack",
      provider: "dstack",
      measurements: { agent: "sha256:abc" },
      freshness: { nonce: "n" },
      claims: { debugDisabled: true },
    });
  });

  it("collects normalized evidence from an HTTP endpoint", async () => {
    const request = vi.fn(async () =>
      Response.json({
        kind: "tdx",
        provider: "dstack",
        securityVersion: 3,
        measurements: { os: "abc" },
      }),
    );

    await expect(
      collectDstackTeeEvidence({
        endpointUrl: "https://tee.example.test/evidence",
        fetch: request as unknown as typeof fetch,
        env: {},
      }),
    ).resolves.toMatchObject({
      kind: "tdx",
      provider: "dstack",
      securityVersion: 3,
      measurements: { os: "abc" },
    });
    expect(request).toHaveBeenCalledWith("https://tee.example.test/evidence", {
      method: "GET",
      headers: { accept: "application/json" },
    });
  });

  it("fails when no evidence source is configured", async () => {
    await expect(
      collectDstackTeeEvidence({ env: {}, evidencePath: "" }),
    ).rejects.toThrow(/No dstack TEE evidence source configured/);
  });

  it("rejects an oversized evidence payload (decompression-bomb guard)", async () => {
    await expect(
      collectDstackTeeEvidence({
        maxPayloadBytes: 16,
        env: {
          ELIZA_TEE_EVIDENCE_JSON: JSON.stringify({
            kind: "dstack",
            measurements: { agent: `sha256:${"a".repeat(64)}` },
          }),
        },
      }),
    ).rejects.toThrow(/payload exceeds 16 bytes/);
  });

  it("refuses a plain-http evidence endpoint under the production profile", async () => {
    await expect(
      collectDstackTeeEvidence({
        endpointUrl: "http://tee.example.test/evidence",
        requireSecureTransport: true,
        fetch: (async () =>
          Response.json({ kind: "dstack" })) as unknown as typeof fetch,
        env: {},
      }),
    ).rejects.toThrow(/must be https:/);
  });

  it("refuses NODE_TLS_REJECT_UNAUTHORIZED=0 under the production profile", async () => {
    await expect(
      collectDstackTeeEvidence({
        requireSecureTransport: true,
        env: {
          NODE_TLS_REJECT_UNAUTHORIZED: "0",
          ELIZA_TEE_EVIDENCE_JSON: JSON.stringify({ kind: "dstack" }),
        },
      }),
    ).rejects.toThrow(/NODE_TLS_REJECT_UNAUTHORIZED=0/);
  });

  it("enforces a pinned KMS identity", async () => {
    await expect(
      collectDstackTeeEvidence({
        expectedKmsPublicKey: "pinned-key",
        env: {
          ELIZA_TEE_EVIDENCE_JSON: JSON.stringify({
            kind: "dstack",
            kmsPublicKey: "rogue-key",
          }),
        },
      }),
    ).rejects.toThrow(/KMS identity does not match the pinned public key/);

    await expect(
      collectDstackTeeEvidence({
        expectedKmsPublicKey: "pinned-key",
        env: {
          ELIZA_TEE_EVIDENCE_JSON: JSON.stringify({
            kind: "dstack",
            kmsPublicKey: "pinned-key",
          }),
        },
      }),
    ).resolves.toMatchObject({ kind: "dstack", provider: "dstack" });
  });
});
