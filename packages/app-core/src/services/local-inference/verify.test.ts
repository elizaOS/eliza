import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { InstalledModel } from "./types";
import { hashFile, verifyInstalledModel } from "./verify";

async function writeGgufFixture(
  file: string,
  body: Buffer = Buffer.from("xxxx"),
): Promise<Buffer> {
  const content = Buffer.concat([Buffer.from("GGUF", "ascii"), body]);
  await fs.writeFile(file, content);
  return content;
}

function makeModel(overrides: Partial<InstalledModel>): InstalledModel {
  return {
    id: "test",
    displayName: "Test",
    path: "/nope",
    sizeBytes: 0,
    installedAt: new Date().toISOString(),
    lastUsedAt: null,
    source: "milady-download",
    ...overrides,
  };
}

describe("verify", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "milady-verify-"));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("hashFile matches crypto.createHash output", async () => {
    const file = path.join(tmp, "data.bin");
    const body = Buffer.from("hello world, this is a test payload");
    await fs.writeFile(file, body);

    const expected = createHash("sha256").update(body).digest("hex");
    expect(await hashFile(file)).toBe(expected);
  });

  it("reports 'missing' when the file doesn't exist", async () => {
    const model = makeModel({ path: path.join(tmp, "ghost.gguf") });
    const result = await verifyInstalledModel(model);
    expect(result.state).toBe("missing");
    expect(result.currentSha256).toBeNull();
    expect(result.currentBytes).toBeNull();
  });

  it("reports 'truncated' when the magic bytes are wrong", async () => {
    const file = path.join(tmp, "not-gguf.bin");
    await fs.writeFile(file, Buffer.from("NOPE header then stuff"));
    const model = makeModel({ path: file });
    const result = await verifyInstalledModel(model);
    expect(result.state).toBe("truncated");
    expect(result.currentSha256).toBeNull();
    expect(result.currentBytes).toBeGreaterThan(0);
  });

  it("reports 'unknown' for a valid GGUF that has no baseline hash yet", async () => {
    const file = path.join(tmp, "ok.gguf");
    const content = await writeGgufFixture(file);
    const model = makeModel({ path: file });
    const result = await verifyInstalledModel(model);
    expect(result.state).toBe("unknown");
    expect(result.currentSha256).toBe(
      createHash("sha256").update(content).digest("hex"),
    );
    expect(result.expectedSha256).toBeNull();
  });

  it("reports 'ok' when the stored sha256 matches", async () => {
    const file = path.join(tmp, "ok.gguf");
    const content = await writeGgufFixture(file);
    const sha256 = createHash("sha256").update(content).digest("hex");
    const model = makeModel({ path: file, sha256 });
    const result = await verifyInstalledModel(model);
    expect(result.state).toBe("ok");
    expect(result.currentSha256).toBe(sha256);
    expect(result.expectedSha256).toBe(sha256);
  });

  it("reports 'mismatch' when the stored hash doesn't match the file", async () => {
    const file = path.join(tmp, "tampered.gguf");
    await writeGgufFixture(file);
    const model = makeModel({
      path: file,
      sha256: "0".repeat(64),
    });
    const result = await verifyInstalledModel(model);
    expect(result.state).toBe("mismatch");
    expect(result.currentSha256).not.toBe("0".repeat(64));
  });
});
