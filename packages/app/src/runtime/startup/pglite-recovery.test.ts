import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadElizaConfig } from "@elizaos/agent";
import {
  createPgliteInitError,
  PGLITE_ERROR_CODES,
  PgliteInitError,
} from "@elizaos/plugin-sql/errors";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolveRuntimeBootstrapFailure } from "../runtime-bootstrap-policy";

vi.mock("@elizaos/agent", () => ({
  getLastFailedPluginNames: () => [],
  loadElizaConfig: vi.fn(() => ({})),
  resolveDefaultAgentWorkspaceDir: () => "/unused-workspace",
  resolveUserPath: (value: string) => value,
}));
vi.mock("../pglite-auto-reset.js", () => ({
  resetPluginSqlPgliteSingleton: vi.fn(),
}));

import { resetPluginSqlPgliteSingleton } from "../pglite-auto-reset.js";
import {
  attemptPgliteAutoReset,
  normalizePgliteStartupError,
} from "./pglite-recovery";

it("preserves an existing typed manual-reset error", () => {
  const error = createPgliteInitError(
    PGLITE_ERROR_CODES.MANUAL_RESET_REQUIRED,
    "Unreadable database",
    { dataDir: "/workspace/.elizadb" },
  );
  expect(normalizePgliteStartupError(error)).toBe(error);
});

it("retains structured corruption metadata through an unrelated wrapper code", () => {
  const cause = createPgliteInitError(
    PGLITE_ERROR_CODES.CORRUPT_DATA,
    "Unreadable database",
    { dataDir: "/workspace/.elizadb" },
  );
  const error = Object.assign(
    new Error("Plugin initialization failed", { cause }),
    {
      code: "PLUGIN_START_FAILED",
    },
  );
  const result = normalizePgliteStartupError(error);
  expect(result).toBeInstanceOf(PgliteInitError);
  expect(result).toMatchObject({
    code: PGLITE_ERROR_CODES.MANUAL_RESET_REQUIRED,
    dataDir: "/workspace/.elizadb",
    cause: error,
  });
});

it("does not quarantine a database based on unstructured error text or an active lock", async () => {
  for (const error of [
    new Error("Aborted(): migrations._migrations from @elizaos/plugin-sql"),
    new Error(
      "rename or delete only this directory before retrying: /workspace/.elizadb",
    ),
    createPgliteInitError(
      PGLITE_ERROR_CODES.ACTIVE_LOCK,
      "Database is in use",
      {
        dataDir: "/workspace/.elizadb",
      },
    ),
  ]) {
    expect(normalizePgliteStartupError(error)).toBe(error);
    await expect(attemptPgliteAutoReset(error)).resolves.toBeNull();
  }
  expect(resetPluginSqlPgliteSingleton).not.toHaveBeenCalled();
});

const temporaryRoots: string[] = [];
beforeEach(() => vi.clearAllMocks());
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function existingDatabase() {
  const root = await mkdtemp(path.join(os.tmpdir(), "eliza-preserve-storage-"));
  temporaryRoots.push(root);
  const dataDir = path.join(root, ".elizadb");
  await mkdir(dataDir);
  const file = path.join(dataDir, "preserved-data");
  const bytes = Buffer.from("Existing user data\0must remain unchanged");
  await writeFile(file, bytes, { mode: 0o600 });
  return { root, dataDir, file, bytes };
}

it.each([
  PGLITE_ERROR_CODES.MANUAL_RESET_REQUIRED,
  PGLITE_ERROR_CODES.CORRUPT_DATA,
])(
  "explicit preservation retains files and the terminal failure for wrapped %s",
  async (code) => {
    vi.stubEnv("ELIZA_PGLITE_AUTO_RESET", "0");
    const fixture = await existingDatabase();
    const before = await stat(fixture.file),
      dirBefore = await stat(fixture.dataDir);
    const error = new Error("Plugin initialization failed", {
      cause: createPgliteInitError(code, "Synthetic unreadable database", {
        dataDir: fixture.dataDir,
      }),
    });
    await expect(attemptPgliteAutoReset(error)).resolves.toBeNull();
    const after = await stat(fixture.file),
      dirAfter = await stat(fixture.dataDir);
    for (const key of ["ino", "size", "mode", "mtimeMs", "ctimeMs"] as const) {
      expect(after[key]).toBe(before[key]);
      expect(dirAfter[key]).toBe(dirBefore[key]);
    }
    expect(await readFile(fixture.file)).toEqual(fixture.bytes);
    expect(await readdir(fixture.root)).toEqual([".elizadb"]);
    expect(resetPluginSqlPgliteSingleton).not.toHaveBeenCalled();
    expect(loadElizaConfig).not.toHaveBeenCalled();
    const normalized = normalizePgliteStartupError(error);
    expect(
      resolveRuntimeBootstrapFailure({
        attempt: 1,
        err: normalized,
        firstFailureAt: 0,
        now: 1,
      }),
    ).toMatchObject({
      state: "error",
      phase: "runtime-error",
      shouldRetry: false,
    });
  },
);

it("retains the existing quarantine behavior when preservation is not selected", async () => {
  vi.stubEnv("ELIZA_PGLITE_AUTO_RESET", undefined);
  const fixture = await existingDatabase();
  const error = createPgliteInitError(
    PGLITE_ERROR_CODES.MANUAL_RESET_REQUIRED,
    "Synthetic unreadable database",
    { dataDir: fixture.dataDir },
  );
  const backup = await attemptPgliteAutoReset(error);
  expect(backup).toMatch(/\.elizadb\.corrupt-\d+$/);
  if (!backup) throw new Error("Expected a quarantined fixture directory");
  expect(await readdir(fixture.root)).toEqual([path.basename(backup)]);
  expect(await readFile(path.join(backup, "preserved-data"))).toEqual(
    fixture.bytes,
  );
  expect(resetPluginSqlPgliteSingleton).toHaveBeenCalledTimes(2);
});
