/** Exercises complete configuration bytes and the real pre-import process boundary. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { loadConfidentialRuntimeDocument } from "./confidential-entry.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture(bytes: string) {
  const directory = await mkdtemp(join(tmpdir(), "confidential-entry-"));
  directories.push(directory);
  const path = join(directory, "runtime.json");
  await writeFile(path, bytes);
  return {
    ELIZA_CONFIDENTIAL_RUNTIME_CONFIG: path,
    ELIZA_CONFIDENTIAL_RUNTIME_CONFIG_SHA256: createHash("sha256")
      .update(bytes)
      .digest("hex"),
  };
}
it("reads the exact approved document and rejects later byte changes", async () => {
  const text = "complete Ω configuration".repeat(2000);
  const bytes = JSON.stringify({ text });
  const env = await fixture(bytes);
  expect(await loadConfidentialRuntimeDocument(env)).toEqual({ text });
  await writeFile(env.ELIZA_CONFIDENTIAL_RUNTIME_CONFIG, `${bytes}\n`);
  await expect(loadConfidentialRuntimeDocument(env)).rejects.toThrow(
    "configuration rejected",
  );
});
it("rejects absent authority, relative paths, noncanonical digests and malformed JSON", async () => {
  await expect(loadConfidentialRuntimeDocument({})).rejects.toThrow(
    "configuration rejected",
  );
  const env = await fixture("{invalid");
  await expect(loadConfidentialRuntimeDocument(env)).rejects.toThrow();
  await expect(
    loadConfidentialRuntimeDocument({
      ...env,
      ELIZA_CONFIDENTIAL_RUNTIME_CONFIG: "runtime.json",
    }),
  ).rejects.toThrow("configuration rejected");
  await expect(
    loadConfidentialRuntimeDocument({
      ...env,
      ELIZA_CONFIDENTIAL_RUNTIME_CONFIG_SHA256:
        env.ELIZA_CONFIDENTIAL_RUNTIME_CONFIG_SHA256.toUpperCase(),
    }),
  ).rejects.toThrow("configuration rejected");
});
it("exits without application import or configuration disclosure on digest rejection", async () => {
  const env = await fixture('{"secret":"synthetic-private-value"}');
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./confidential-entry.ts", import.meta.url))],
    {
      env: {
        ...process.env,
        ...env,
        ELIZA_CONFIDENTIAL_RUNTIME_CONFIG_SHA256: "0".repeat(64),
      },
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe(
    "Confidential agent process startup or shutdown failed.\n",
  );
});
