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
});
