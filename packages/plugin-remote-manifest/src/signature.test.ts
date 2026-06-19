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

function writeTarball(contents = "hello world"): string {
  const dir = mkdtempSync(join(tmpdir(), "plg-"));
  const tarball = join(dir, "plugin.tgz");
  writeFileSync(tarball, Buffer.from(contents, "utf8"));
  return tarball;
}

async function expectSignatureFailure(
  promise: Promise<unknown>,
  code: PluginSignatureError["code"],
): Promise<void> {
  try {
    await promise;
    throw new Error("Expected signature verification to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(PluginSignatureError);
    expect((error as PluginSignatureError).code).toBe(code);
  }
}

describe("verifyPluginArtifact", () => {
  it("accepts a valid hash + ed25519 signature", async () => {
    const kms = createKmsClient({ backend: "memory" });
    const tarball = writeTarball();

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
    expect(sink.snapshot()).toEqual([
      expect.objectContaining({
        actor: { type: "system", id: "agent" },
        action: "plugin.install",
        result: "success",
        resource: { type: "plugin", id: "test" },
        metadata: { plugin_id: "test", version: "1.0.0" },
      }),
    ]);
  });

  it("rejects a hash mismatch with code and failure audit metadata", async () => {
    const kms = createKmsClient({ backend: "memory" });
    const tarball = writeTarball();
    await kms.getOrCreateKey(PLUGIN_MANIFEST_KEY);
    const sink = new InMemorySink();
    const ad = new AuditDispatcher({ sinks: [sink] });

    await expectSignatureFailure(
      verifyPluginArtifact({
        pluginId: "test",
        version: "1.0.0",
        tarballPath: tarball,
        signature: { hash: "00".repeat(32), signature: "AAAA" },
        kms,
        auditDispatcher: ad,
        actorId: "user-1",
      }),
      "HASH_MISMATCH",
    );
    expect(sink.snapshot()).toEqual([
      expect.objectContaining({
        actor: { type: "user", id: "user-1" },
        action: "plugin.install",
        result: "failure",
        resource: { type: "plugin", id: "test" },
        metadata: {
          plugin_id: "test",
          version: "1.0.0",
          reason: "hash_mismatch",
        },
      }),
    ]);
  });

  it("rejects a missing hash or signature with specific codes", async () => {
    const kms = createKmsClient({ backend: "memory" });
    const tarball = writeTarball("hi");

    const hashHex = await sha256File(tarball);
    await expectSignatureFailure(
      verifyPluginArtifact({
        pluginId: "test",
        version: "1.0.0",
        tarballPath: tarball,
        signature: { hash: "", signature: "AAAA" },
        kms,
      }),
      "MISSING_HASH",
    );
    await expectSignatureFailure(
      verifyPluginArtifact({
        pluginId: "test",
        version: "1.0.0",
        tarballPath: tarball,
        signature: { hash: hashHex, signature: "" },
        kms,
      }),
      "MISSING_SIGNATURE",
    );
  });

  it("rejects a matching hash with the wrong signature and audits bad_signature", async () => {
    const kms = createKmsClient({ backend: "memory" });
    const tarball = writeTarball();
    await kms.getOrCreateKey(PLUGIN_MANIFEST_KEY);
    const sink = new InMemorySink();
    const ad = new AuditDispatcher({ sinks: [sink] });
    const hashHex = await sha256File(tarball);

    await expectSignatureFailure(
      verifyPluginArtifact({
        pluginId: "test",
        version: "1.0.0",
        tarballPath: tarball,
        signature: {
          hash: hashHex,
          signature: Buffer.from(new Uint8Array(64).fill(1)).toString("base64"),
        },
        kms,
        auditDispatcher: ad,
      }),
      "BAD_SIGNATURE",
    );

    expect(sink.snapshot()).toEqual([
      expect.objectContaining({
        actor: { type: "system", id: "agent" },
        action: "plugin.install",
        result: "failure",
        metadata: {
          plugin_id: "test",
          version: "1.0.0",
          reason: "bad_signature",
        },
      }),
    ]);
  });
});
