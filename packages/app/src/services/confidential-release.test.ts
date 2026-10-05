/**
 * Exercises real Ed25519 release signatures and exact-byte dstack identities.
 * No simulated signature verifier or hardware-attestation claim is involved.
 */
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { signConfidentialRelease } from "./confidential-release.ts";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
const agentId = "a17e934a-d1be-4115-87ca-a7f1b379f390";
const manifest = {
  name: `eliza-${agentId}`,
  manifest_version: "3",
  key_provider: "kms",
  key_provider_id: "aabbcc",
  public_logs: false,
  public_sysinfo: false,
  no_instance_id: false,
  secure_time: true,
  storage_discard: false,
  requirements: { platforms: ["dstack-tdx"] },
};
const input = {
  agentId,
  compose: JSON.stringify(manifest),
  osImageHash: "a".repeat(64),
  variant: "dstack-tdx",
  notBefore: "2026-09-22T00:00:00Z",
  expiresAt: "2026-09-23T00:00:00Z",
};

describe("confidential release signing", () => {
  it("requires a distinct measured identity for a different agent", () => {
    const otherId = "b28f934a-d1be-4115-87ca-a7f1b379f390";
    expect(() =>
      signConfidentialRelease({ ...input, agentId: otherId }, pem),
    ).toThrow();
    const first = signConfidentialRelease(input, pem);
    const second = signConfidentialRelease(
      {
        ...input,
        agentId: otherId,
        compose: JSON.stringify({ ...manifest, name: `eliza-${otherId}` }),
      },
      pem,
    );
    const firstIdentity = JSON.parse(
      Buffer.from(first.payload, "base64").toString(),
    );
    const secondIdentity = JSON.parse(
      Buffer.from(second.payload, "base64").toString(),
    );
    expect(firstIdentity.appId).not.toBe(secondIdentity.appId);
    expect(firstIdentity.composeHash).not.toBe(secondIdentity.composeHash);
  });
  it("runs the CLI with private output and refuses to overwrite an existing envelope", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eliza-release-signing-"));
    try {
      const source = join(directory, "release.json");
      const key = join(directory, "authority.pem");
      const output = join(directory, "signed.json");
      await writeFile(source, JSON.stringify(input));
      await writeFile(key, pem, { mode: 0o600 });
      const script = fileURLToPath(
        new URL("../../scripts/sign-confidential-release.ts", import.meta.url),
      );
      const args = [
        script,
        "--input",
        source,
        "--key",
        key,
        "--output",
        output,
      ];
      const first = spawnSync("bun", args, { encoding: "utf8" });
      expect(first.status, first.stderr).toBe(0);
      expect(first.stdout + first.stderr).not.toContain(pem);
      const envelope = await readFile(output, "utf8");
      if (process.platform !== "win32")
        expect((await stat(output)).mode & 0o777).toBe(0o600);
      const second = spawnSync("bun", args, { encoding: "utf8" });
      expect(second.status).toBe(1);
      expect(await readFile(output, "utf8")).toBe(envelope);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("authorizes exact compose bytes and rejects any changed signed payload", () => {
    const envelope = signConfidentialRelease(input, pem);
    const bytes = Buffer.from(envelope.payload, "base64");
    const payload = JSON.parse(bytes.toString());
    expect(payload.composeHash).toBe(
      createHash("sha256").update(input.compose).digest("hex"),
    );
    expect(payload.appId).toBe(payload.composeHash.slice(0, 40));
    const message = Buffer.concat([
      Buffer.from("eliza-dstack-release-v1\0"),
      bytes,
    ]);
    expect(
      verify(
        null,
        message,
        publicKey,
        Buffer.from(envelope.signature, "base64"),
      ),
    ).toBe(true);
    message.writeUInt8(
      message.readUInt8(message.length - 1) ^ 1,
      message.length - 1,
    );
    expect(
      verify(
        null,
        message,
        publicKey,
        Buffer.from(envelope.signature, "base64"),
      ),
    ).toBe(false);
    const reformatted = signConfidentialRelease(
      { ...input, compose: JSON.stringify(manifest, null, 2) },
      pem,
    );
    expect(
      JSON.parse(Buffer.from(reformatted.payload, "base64").toString())
        .composeHash,
    ).not.toBe(payload.composeHash);
  });

  it.each([
    { public_logs: true },
    { public_sysinfo: true },
    { no_instance_id: true },
    { secure_time: false },
    { storage_discard: true },
    { key_provider: "none" },
    { manifest_version: 2 },
    { key_provider_id: "" },
    { requirements: { platforms: ["dstack-nitro-enclave"] } },
  ])("refuses incompatible measured launch controls %j", (change) => {
    expect(() =>
      signConfidentialRelease(
        { ...input, compose: JSON.stringify({ ...manifest, ...change }) },
        pem,
      ),
    ).toThrow();
  });

  it("refuses reversed validity, undeclared inputs and a non-Ed25519 authority", () => {
    expect(() =>
      signConfidentialRelease({ ...input, expiresAt: input.notBefore }, pem),
    ).toThrow();
    expect(() =>
      signConfidentialRelease({ ...input, appId: "forged" }, pem),
    ).toThrow();
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    expect(() =>
      signConfidentialRelease(
        input,
        rsa.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      ),
    ).toThrow();
  });
});
