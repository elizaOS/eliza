/** Opening and probing a vault must resolve the same branded state directory. */

import {
  getBootConfig,
  setBootConfig,
} from "@elizaos/shared/config/boot-config-store";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defaultPgliteVaultDataDir } from "../src/vault/pglite-vault.js";
import { resolveDefaultVaultDataDir } from "../src/vault/vault.js";
import { resolveDefaultVaultRoot } from "../src/vault/vault-paths.js";

let previousConfig: ReturnType<typeof getBootConfig>;
beforeEach(() => {
  previousConfig = getBootConfig();
  setBootConfig({
    ...previousConfig,
    envAliases: [["FIXTURE_STATE_DIR", "ELIZA_STATE_DIR"]],
  });
  vi.stubEnv("ELIZA_STATE_DIR", "");
  vi.stubEnv("FIXTURE_STATE_DIR", "/tmp/branded-vault");
});
afterEach(() => {
  setBootConfig(previousConfig);
  vi.unstubAllEnvs();
});
it("uses a branded alias for both storage creation and the existence probe", () => {
  expect(defaultPgliteVaultDataDir()).toBe("/tmp/branded-vault/.vault-pglite");
  expect(resolveDefaultVaultDataDir()).toBe("/tmp/branded-vault/.vault-pglite");
});
it("preserves canonical environment and explicit directory precedence", () => {
  vi.stubEnv("ELIZA_STATE_DIR", "/tmp/canonical-vault");
  expect(defaultPgliteVaultDataDir()).toBe(
    "/tmp/canonical-vault/.vault-pglite",
  );
  expect(resolveDefaultVaultRoot("/tmp/explicit-vault")).toBe(
    "/tmp/explicit-vault",
  );
});
