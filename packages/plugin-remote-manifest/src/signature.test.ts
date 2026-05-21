import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AuditDispatcher,
  createKmsClient,
  InMemorySink,
} from "@elizaos/security";
import {
  PLUGIN_MANIFEST_KEY,
  PluginSignatureError,
  sha256File,
  verifyPluginArtifact,
} from "./signature.js";

async function sign(kms: ReturnType<typeof createKmsClient>, path: string) {
  await kms.getOrCreateKey(PLUGIN_MANIFEST_KEY);
  const hashHex = await sha256File(path);
  const hashBytes = new Uint8Array(hashHex.length / 2);
  for (let i = 0; i < hashBytes.length; i++) {
    hashBytes[i] = Number.parseInt(hashHex.slice(i * 2, i * 2 + 2), 16);
  }
  const { signature } = await kms.sign(
    PLUGIN_MANIFEST_KEY,
    hashBytes,
    "ed25519",
  );
  return {
    hash: hashHex,
    signature: Buffer.from(signature).toString("base64"),
  };
}

describe("verifyPluginArtifact", () => {
  it("accepts a valid hash + ed25519 signature", async () => {
    const kms = createKmsClient({ backend: "memory" });
    const dir = mkdtempSync(join(tmpdir(), "plg-"));
    const tarball = join(dir, "plugin.tgz");
    writeFileSync(tarball, Buffer.from("hello world", "utf8"));

    const sig = await sign(kms, tarball);
    const sink = new InMemorySink();
    const ad = new AuditDispatcher({ sinks: [sink] });
    await verifyPluginArtifact({
      pluginId: "test",
      version: "1.0.0",
      tarballPath: tarball,
      signature: sig,
      kms,
      auditDispatcher: ad,
    });
    expect(sink.snapshot().some((e) => e.result === "success")).toBe(true);
  });

  it("rejects a hash mismatch", async () => {
    const kms = createKmsClient({ backend: "memory" });
    const dir = mkdtempSync(join(tmpdir(), "plg-"));
    const tarball = join(dir, "plugin.tgz");
    writeFileSync(tarball, Buffer.from("hello world", "utf8"));
    await kms.getOrCreateKey(PLUGIN_MANIFEST_KEY);

    await expect(
      verifyPluginArtifact({
        pluginId: "test",
        version: "1.0.0",
        tarballPath: tarball,
        signature: { hash: "00".repeat(32), signature: "AAAA" },
        kms,
      }),
    ).rejects.toThrow(PluginSignatureError);
  });

  it("rejects a missing signature", async () => {
    const kms = createKmsClient({ backend: "memory" });
    const dir = mkdtempSync(join(tmpdir(), "plg-"));
    const tarball = join(dir, "plugin.tgz");
    writeFileSync(tarball, Buffer.from("hi", "utf8"));

    const hashHex = await sha256File(tarball);
    await expect(
      verifyPluginArtifact({
        pluginId: "test",
        version: "1.0.0",
        tarballPath: tarball,
        signature: { hash: hashHex, signature: "" },
        kms,
      }),
    ).rejects.toThrow(/missing required Ed25519/);
  });
});
