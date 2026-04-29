import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  emptyStore,
  readStore,
  removeSecret,
  setPermissions,
  setSecret,
  StoreFormatError,
  STORE_VERSION,
  writeStore,
} from "../src/store.js";

describe("store", () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "confidant-store-"));
    path = join(dir, "confidant.json");
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("returns empty store when file does not exist", async () => {
    const data = await readStore(path);
    expect(data).toEqual(emptyStore());
  });

  it("writes 0600 mode and reads back", async () => {
    const data = setSecret(emptyStore(), "llm.openrouter.apiKey", {
      kind: "literal",
      source: "file",
      ciphertext: "v1:n:t:c",
      lastModified: 1000,
    });
    await writeStore(path, data);
    const stat = await fs.stat(path);
    // mask off file-type bits
    expect(stat.mode & 0o777).toBe(0o600);
    const round = await readStore(path);
    expect(round.secrets["llm.openrouter.apiKey"]).toMatchObject({
      kind: "literal",
      ciphertext: "v1:n:t:c",
      lastModified: 1000,
    });
  });

  it("writes are atomic (rename, not partial)", async () => {
    // The temp file should not linger after a successful write.
    const data = emptyStore();
    await writeStore(path, data);
    const tmpPath = `${path}.tmp`;
    await expect(fs.access(tmpPath)).rejects.toThrow();
  });

  it("refuses to read a higher-versioned store", async () => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path,
      JSON.stringify({ version: STORE_VERSION + 1, secrets: {}, permissions: {} }),
    );
    await expect(readStore(path)).rejects.toThrow(StoreFormatError);
  });

  it("rejects malformed JSON", async () => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path, "{");
    await expect(readStore(path)).rejects.toThrow(StoreFormatError);
  });

  it("rejects literal entries without ciphertext", async () => {
    await fs.writeFile(
      path,
      JSON.stringify({
        version: 1,
        secrets: {
          "x.y.z": { kind: "literal", lastModified: 0 },
        },
        permissions: {},
      }),
    );
    await expect(readStore(path)).rejects.toThrow(StoreFormatError);
  });

  it("rejects reference entries with invalid source", async () => {
    await fs.writeFile(
      path,
      JSON.stringify({
        version: 1,
        secrets: {
          "x.y.z": { kind: "reference", source: "fake", ref: "fake://x" },
        },
        permissions: {},
      }),
    );
    await expect(readStore(path)).rejects.toThrow(StoreFormatError);
  });

  it("preserves permissions on roundtrip", async () => {
    const data = setPermissions(emptyStore(), "weather-bot", {
      grants: [
        {
          pattern: "llm.openrouter.apiKey",
          mode: "always",
          grantedAt: 100,
          reason: "user approved",
        },
      ],
    });
    await writeStore(path, data);
    const round = await readStore(path);
    expect(round.permissions["weather-bot"]?.grants).toHaveLength(1);
    expect(round.permissions["weather-bot"]?.grants[0]).toMatchObject({
      pattern: "llm.openrouter.apiKey",
      mode: "always",
      reason: "user approved",
    });
  });

  it("removeSecret is idempotent for missing keys", () => {
    const data = emptyStore();
    expect(removeSecret(data, "x.y.z")).toBe(data);
  });
});
