/**
 * Deterministic transport and integrity coverage for anonymous GHCR publication proof.
 */

import { describe, expect, test } from "bun:test";
import {
  GhcrVerificationError,
  parseCliArguments,
  verifyAnonymousGhcrManifest,
} from "../verify-ghcr-anonymous-manifest.mjs";

const DIGEST = `sha256:${"a".repeat(64)}`;
const IMAGE_ID = `sha256:${"b".repeat(64)}`;

function tokenResponse(token = "anonymous-token"): Response {
  return Response.json({ token });
}

function manifestResponse({
  digest = DIGEST,
  imageId = IMAGE_ID,
  status = 200,
  body,
}: {
  digest?: string;
  imageId?: string;
  status?: number;
  body?: string;
} = {}): Response {
  return new Response(body ?? JSON.stringify({ config: { digest: imageId } }), {
    status,
    headers: { "docker-content-digest": digest },
  });
}

describe("anonymous GHCR manifest verification", () => {
  test("accepts each CLI input exactly once and rejects ambiguous arguments", () => {
    expect(
      parseCliArguments([
        "--digest",
        DIGEST,
        "--repository",
        "elizaos/eliza",
        "--image-id",
        IMAGE_ID,
      ]),
    ).toEqual({
      repository: "elizaos/eliza",
      digest: DIGEST,
      imageId: IMAGE_ID,
    });
    expect(() =>
      parseCliArguments([
        "--repository",
        "elizaos/eliza",
        "--repository",
        "elizaos/eliza-demo",
        "--digest",
        DIGEST,
        "--image-id",
        IMAGE_ID,
      ]),
    ).toThrow("Expected one value each");
    expect(() =>
      parseCliArguments([
        "--repository",
        "elizaos/eliza",
        "--digest",
        DIGEST,
        "--image-id",
      ]),
    ).toThrow("Expected one value each");
  });

  test("accepts only an anonymously readable exact manifest and image config", async () => {
    const urls: string[] = [];
    const result = await verifyAnonymousGhcrManifest({
      repository: "ElizaOS/Eliza",
      digest: DIGEST,
      imageId: IMAGE_ID,
      fetchImpl: async (input) => {
        const url = String(input);
        urls.push(url);
        return url.includes("/token?") ? tokenResponse() : manifestResponse();
      },
      sleep: async () => {},
    });

    expect(result).toEqual({
      repository: "elizaos/eliza",
      digest: DIGEST,
      imageId: IMAGE_ID,
      attempts: 1,
    });
    expect(urls).toEqual([
      "https://ghcr.io/token?scope=repository%3Aelizaos%2Feliza%3Apull",
      `https://ghcr.io/v2/elizaos/eliza/manifests/${DIGEST}`,
    ]);
  });

  test("retries propagation and then fails closed on persistent anonymous 404", async () => {
    const retryMessages: string[] = [];
    let fetchCount = 0;
    const verification = verifyAnonymousGhcrManifest({
      repository: "elizaos/eliza",
      digest: DIGEST,
      imageId: IMAGE_ID,
      attempts: 3,
      fetchImpl: async (input) => {
        fetchCount += 1;
        return String(input).includes("/token?")
          ? tokenResponse()
          : new Response("private-response-secret", { status: 404 });
      },
      sleep: async () => {},
      onRetry: (message) => retryMessages.push(message),
    });

    await expect(verification).rejects.toEqual(
      new GhcrVerificationError(
        "Anonymous GHCR manifest request returned HTTP 404.",
        { retryable: true },
      ),
    );
    expect(fetchCount).toBe(6);
    expect(retryMessages).toHaveLength(2);
    expect(retryMessages.join("\n")).not.toContain("private-response-secret");
  });

  test("never retries an integrity mismatch", async () => {
    let fetchCount = 0;
    const verification = verifyAnonymousGhcrManifest({
      repository: "elizaos/eliza",
      digest: DIGEST,
      imageId: IMAGE_ID,
      fetchImpl: async (input) => {
        fetchCount += 1;
        return String(input).includes("/token?")
          ? tokenResponse()
          : manifestResponse({ digest: `sha256:${"c".repeat(64)}` });
      },
      sleep: async () => {},
    });

    await expect(verification).rejects.toThrow(
      "Anonymous GHCR response returned a different manifest digest.",
    );
    expect(fetchCount).toBe(2);
  });

  test("fails closed without leaking malformed token or manifest bodies", async () => {
    const tokenSecret = "token-response-secret-that-must-not-escape";
    const malformedToken = verifyAnonymousGhcrManifest({
      repository: "elizaos/eliza",
      digest: DIGEST,
      imageId: IMAGE_ID,
      attempts: 1,
      fetchImpl: async () => new Response(tokenSecret),
      sleep: async () => {},
    });
    await expect(malformedToken).rejects.toThrow(
      "Anonymous GHCR token request returned invalid JSON.",
    );
    await expect(malformedToken).rejects.not.toThrow(tokenSecret);

    const manifestSecret = "manifest-response-secret-that-must-not-escape";
    const malformedManifest = verifyAnonymousGhcrManifest({
      repository: "elizaos/eliza",
      digest: DIGEST,
      imageId: IMAGE_ID,
      attempts: 1,
      fetchImpl: async (input) =>
        String(input).includes("/token?")
          ? tokenResponse()
          : new Response(manifestSecret, {
              headers: { "docker-content-digest": DIGEST },
            }),
      sleep: async () => {},
    });
    await expect(malformedManifest).rejects.toThrow(
      "Anonymous GHCR manifest request returned invalid JSON.",
    );
    await expect(malformedManifest).rejects.not.toThrow(manifestSecret);
  });

  test("retries transport failures but preserves a sanitized typed cause chain", async () => {
    const transportFailure = new Error(
      "socket included a credential-shaped secret",
    );
    let fetchCount = 0;
    const verification = verifyAnonymousGhcrManifest({
      repository: "elizaos/eliza",
      digest: DIGEST,
      imageId: IMAGE_ID,
      attempts: 2,
      fetchImpl: async () => {
        fetchCount += 1;
        throw transportFailure;
      },
      sleep: async () => {},
      onRetry: () => {},
    });

    try {
      await verification;
      throw new Error("verification unexpectedly succeeded");
    } catch (error) {
      expect(error).toBeInstanceOf(GhcrVerificationError);
      expect((error as Error).message).toBe(
        "Anonymous GHCR token request failed before receiving an HTTP response.",
      );
      expect((error as Error).message).not.toContain("credential-shaped");
      expect((error as Error).cause).toBe(transportFailure);
    }
    expect(fetchCount).toBe(2);
  });

  test("rejects image-config drift and invalid retry configuration", async () => {
    const verification = verifyAnonymousGhcrManifest({
      repository: "elizaos/eliza",
      digest: DIGEST,
      imageId: IMAGE_ID,
      fetchImpl: async (input) =>
        String(input).includes("/token?")
          ? tokenResponse()
          : manifestResponse({ imageId: `sha256:${"c".repeat(64)}` }),
      sleep: async () => {},
    });
    await expect(verification).rejects.toThrow(
      "Published manifest does not reference the boot-verified image config.",
    );
    await expect(
      verifyAnonymousGhcrManifest({
        repository: "elizaos/eliza",
        digest: DIGEST,
        imageId: IMAGE_ID,
        attempts: 0,
      }),
    ).rejects.toThrow("attempts must be an integer from 1 to 10");
  });

  test("rejects malformed repository and digest inputs before networking", async () => {
    let fetchCount = 0;
    const fetchImpl = async () => {
      fetchCount += 1;
      return tokenResponse();
    };

    await expect(
      verifyAnonymousGhcrManifest({
        repository: "elizaos/eliza/extra",
        digest: DIGEST,
        imageId: IMAGE_ID,
        fetchImpl,
      }),
    ).rejects.toThrow("exactly one owner/name pair");
    await expect(
      verifyAnonymousGhcrManifest({
        repository: "elizaos/eliza",
        digest: "develop",
        imageId: IMAGE_ID,
        fetchImpl,
      }),
    ).rejects.toThrow("EXPECTED_DIGEST must be a sha256 digest");
    expect(fetchCount).toBe(0);
  });
});
