/**
 * Regression: the bridge-endpoint resolver must SSRF-guard ONLY untrusted,
 * caller-supplied bridge URLs while leaving trusted internal-mesh URLs
 * (provider-minted handles, docker-bridge / legacy-private records) untouched.
 *
 * `getSafeBridgeEndpoint`'s string branch is the untrusted entry point: when a
 * raw bridge URL string is passed WITHOUT `{ trusted: true }` it routes through
 * `assertSafeOutboundUrl`, so a URL aimed at a private / link-local cloud
 * metadata IP is rejected. The `{ trusted: true }` path (the freshly
 * provisioned provider handle in `provision()`'s restore) must keep reaching
 * the mesh unguarded so control-plane calls to 10.x / docker-bridge hosts still
 * work — blanket-guarding them would break provisioning/restore.
 *
 * The string branch is self-contained (no provider / DB), so this exercises the
 * real method directly.
 */
import { describe, expect, test } from "bun:test";

import { ElizaSandboxService } from "./eliza-sandbox";

type BridgeEndpointResolver = {
  getSafeBridgeEndpoint(
    sandboxOrBridgeUrl: string,
    path: string,
    options?: { trusted?: boolean },
  ): Promise<string>;
};

function resolver(): BridgeEndpointResolver {
  return new ElizaSandboxService() as unknown as BridgeEndpointResolver;
}

describe("ElizaSandboxService bridge SSRF guard (untrusted string bridge URL)", () => {
  test("rejects an untrusted bridge URL pointing at a private IP", async () => {
    await expect(
      resolver().getSafeBridgeEndpoint("http://10.0.0.7:7000", "/api/restore"),
    ).rejects.toThrow(/private or reserved/i);
  });

  test("rejects an untrusted bridge URL pointing at the cloud-metadata IP", async () => {
    await expect(
      resolver().getSafeBridgeEndpoint("http://169.254.169.254", "/api/restore"),
    ).rejects.toThrow(/private or reserved/i);
  });

  test("rejects an untrusted bridge URL pointing at localhost", async () => {
    await expect(
      resolver().getSafeBridgeEndpoint("http://localhost:7000", "/api/restore"),
    ).rejects.toThrow(/localhost/i);
  });

  test("allows a trusted internal-mesh bridge URL to stay unguarded", async () => {
    await expect(
      resolver().getSafeBridgeEndpoint("http://10.0.0.7:7000", "/api/restore", {
        trusted: true,
      }),
    ).resolves.toBe("http://10.0.0.7:7000/api/restore");
  });
});
