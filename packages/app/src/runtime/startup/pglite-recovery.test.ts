import {
  createPgliteInitError,
  PGLITE_ERROR_CODES,
  PgliteInitError,
} from "@elizaos/plugin-sql/errors";
import { expect, it, vi } from "vitest";

vi.mock("@elizaos/agent", () => ({
  getLastFailedPluginNames: () => [],
  loadElizaConfig: () => ({}),
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
