/** Actual normal boot reaches the canonical runtime constructor without a model or live profile. */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createTestVault, type TestVault } from "@elizaos/auth/testing";
import {
  profileStorageKey,
  setEntryMeta,
  writeRoutingConfig,
} from "@elizaos/auth/vault";
import { AgentRuntime, stringToUuid, type UUID } from "@elizaos/core";
import type { ElizaConfig } from "@elizaos/host/protocol";
import { afterEach, expect, test, vi } from "vitest";
import { installProductCharacterHost } from "../../app/src/runtime/install-product-character-host.ts";
import { buildCharacterFromConfig } from "../src/runtime/build-character-config.ts";
import { startEliza } from "../src/runtime/eliza.ts";
import {
  _resetAgentHostBridge,
  getAgentHostBridge,
  setAgentHostBridge,
} from "../src/runtime/host-bridge.ts";
import { applyVaultProfilesForAgent } from "../src/runtime/vault-profile-resolver.ts";

const roots: string[] = [];
const vaults: TestVault[] = [];
const originalEnvironment = { ...process.env };
afterEach(async () => {
  _resetAgentHostBridge();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const key of Object.keys(process.env))
    if (!(key in originalEnvironment)) delete process.env[key];
  Object.assign(process.env, originalEnvironment);
  for (const vault of vaults.splice(0)) await vault.dispose();
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});

test.each([
  "implicit",
  "configured-default",
  "legacy-custom",
  "renamed-beta",
  "renamed-alpha",
  "distinct-identity",
])("normal runtime preserves persona and profile scope: %s", async (mode) => {
  const localAgentMode = mode !== "implicit";
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "product-boot-"));
  roots.push(root);
  vi.stubEnv("ELIZA_STATE_DIR", root);
  vi.stubEnv("ELIZA_CONFIG_PATH", path.join(root, "eliza.json"));
  vi.stubEnv("ELIZA_PERSIST_CONFIG_PATH", path.join(root, "eliza.json"));
  vi.stubEnv("ELIZA_DISABLE_VAULT_PROFILE_RESOLVER", undefined);
  vi.stubEnv("ELIZA_DISABLE_AGENT_WALLET_BOOTSTRAP", "1");
  vi.stubEnv("ELIZA_DISABLE_AUTO_BOOTSTRAP", "1");
  const defaultName = buildCharacterFromConfig({}).name;
  if (!defaultName) throw Error("Canonical default name unavailable");
  const configEntry =
    mode === "implicit"
      ? undefined
      : {
          id: "main",
          default: true,
          name:
            mode === "configured-default"
              ? defaultName
              : mode === "renamed-beta"
                ? "Beta"
                : mode === "renamed-alpha"
                  ? "Alpha"
                  : "Retained original",
          ...(mode.startsWith("renamed-")
            ? { identityName: defaultName }
            : mode === "distinct-identity"
              ? { identityName: "Separate original identity" }
              : {}),
        };
  const config: ElizaConfig = {
    agents: {
      defaults: { workspace: path.join(root, "workspace") },
      ...(configEntry ? { list: [configEntry] } : {}),
    },
  };
  const original = buildCharacterFromConfig(config);
  const originalName = original.name;
  if (!originalName) throw Error("Original name unavailable");
  const originalScope = originalName.toLowerCase().replace(/\s+/g, "-");
  const expectedName =
    mode === "implicit" || mode === "configured-default"
      ? "Alpha"
      : originalName;
  await fs.writeFile(path.join(root, "eliza.json"), JSON.stringify(config));
  const entry = path.join(root, "host.mjs");
  const body =
    'export const nativeCloudRuntime = {apiBaseUrl:"https://cloud.example.com/api/v1",productCharacter:{name:"Alpha",bio:["Product assistant."]}};';
  await fs.writeFile(entry, body);
  await fs.writeFile(
    path.join(root, "manifest.json"),
    JSON.stringify({
      version: 1,
      files: { "host.mjs": createHash("sha256").update(body).digest("hex") },
    }),
  );
  await installProductCharacterHost({
    ELIZA_SMTHRS_RUNTIME_DIR: root,
    ELIZA_NATIVE_GOOGLE_HOST_MODULE: entry,
  });
  const testVault = await createTestVault({ workDir: root });
  vaults.push(testVault);
  const key = "ALPHA_QA_PROFILE_KEY";
  const retained = "synthetic-retained-profile";
  await testVault.vault.set(profileStorageKey(key, "retained"), retained, {
    sensitive: true,
  });
  await testVault.vault.set(
    profileStorageKey(key, "other"),
    "synthetic-other-profile",
    { sensitive: true },
  );
  await setEntryMeta(testVault.vault, key, {
    profiles: [
      { id: "retained", label: "Retained", createdAt: 1 },
      { id: "other", label: "Other", createdAt: 1 },
    ],
    activeProfile: "other",
  });
  await writeRoutingConfig(testVault.vault, {
    rules: [
      {
        keyPattern: key,
        scope: { kind: "agent", agentId: originalScope },
        profileId: "retained",
      },
    ],
  });
  // The real resolver distinguishes the pre-brand scope from the new label.
  await applyVaultProfilesForAgent(testVault.vault, "alpha");
  expect(process.env[key] === retained).toBe(originalScope === "alpha");
  delete process.env[key];
  setAgentHostBridge({
    ...getAgentHostBridge(),
    sharedVault: () => testVault.vault,
  });
  const model = vi
    .spyOn(AgentRuntime.prototype, "useModel")
    .mockImplementation(async () => {
      throw Error("No inference in boot fixture");
    });
  const stop = new Error("Stop at real constructor");
  let identity: UUID | undefined;
  let display: string | undefined;
  let keptProfile = false;
  const construct = () =>
    startEliza({
      headless: true,
      localAgentMode,
      onRuntimeCreated(runtime) {
        identity = runtime.agentId;
        display = runtime.character.name;
        keptProfile = process.env[key] === retained;
        throw stop;
      },
    });
  await expect(construct()).rejects.toBe(stop);
  expect(identity).toBe(original.id ?? stringToUuid(originalName));
  expect(display).toBe(expectedName);
  expect(keptProfile).toBe(true);
  delete process.env[key];
  await expect(construct()).rejects.toBe(stop);
  expect(identity).toBe(original.id ?? stringToUuid(originalName));
  expect(display).toBe(expectedName);
  expect(keptProfile).toBe(true);
  _resetAgentHostBridge();
  setAgentHostBridge({
    ...getAgentHostBridge(),
    sharedVault: () => testVault.vault,
  });
  await installProductCharacterHost({});
  await expect(construct()).rejects.toBe(stop);
  expect(identity).toBe(original.id ?? stringToUuid(originalName));
  expect(display).toBe(originalName);
  expect(
    JSON.parse(await fs.readFile(path.join(root, "eliza.json"), "utf8")),
  ).toEqual(config);
  expect(model).not.toHaveBeenCalled();
});
