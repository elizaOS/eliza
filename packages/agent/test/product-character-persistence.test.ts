/** Real character routes/service, canonical disk config, SQLite and vault routing. */
import fs from "node:fs/promises";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { createTestVault, type TestVault } from "@elizaos/auth/testing";
import {
  profileStorageKey,
  setEntryMeta,
  writeRoutingConfig,
} from "@elizaos/auth/vault";
import { AgentRuntime } from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/testing/runtime";
import { afterEach, expect, test, vi } from "vitest";
import { CharacterFileManager } from "../../../plugins/plugin-assistant/src/features/advanced-capabilities/personality/services/character-file-manager.ts";
import { handleCharacterRoutes } from "../src/api/character-routes.ts";
import { syncRuntimeCharacterToChatStateConfig } from "../src/api/chat-routes.ts";
import { handleConfigRoutes } from "../src/api/config-routes.ts";
import { loadElizaConfig, saveElizaConfig } from "../src/config/config.ts";
import { CharacterSchema } from "../src/config/zod-schema.ts";
import { buildCharacterFromConfig } from "../src/runtime/build-character-config.ts";
import {
  _resetAgentHostBridge,
  getAgentHostBridge,
  setAgentHostBridge,
} from "../src/runtime/host-bridge.ts";
import { buildProductCharacterFromConfig } from "../src/runtime/prepare-product-character-config.ts";
import { applyVaultProfilesForAgent } from "../src/runtime/vault-profile-resolver.ts";
import { ElizaCharacterPersistenceService } from "../src/services/character-persistence.ts";

const roots: string[] = [];
const vaults: TestVault[] = [];
const runtimes: AgentRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    await runtime.stop();
    await runtime.close();
  }
  for (const vault of vaults.splice(0)) await vault.dispose();
  _resetAgentHostBridge();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  delete process.env.ALPHA_QA_PROFILE_KEY;
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});

test.each(["service", "route"])(
  "non-name %s edit preserves original scope across persistence and rebuild",
  async (mode) => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "product-persistence-"),
    );
    roots.push(root);
    vi.stubEnv("ELIZA_STATE_DIR", root);
    vi.stubEnv("ELIZA_CONFIG_PATH", path.join(root, "eliza.json"));
    vi.stubEnv("ELIZA_PERSIST_CONFIG_PATH", path.join(root, "eliza.json"));
    vi.stubEnv("ELIZA_DISABLE_VAULT_PROFILE_RESOLVER", undefined);
    const originalName = buildCharacterFromConfig({}).name;
    if (!originalName) throw Error("Canonical default unavailable");
    const originalScope = originalName.toLowerCase().replace(/\s+/g, "-");
    const config = {
      agents: {
        list: [
          {
            id: "main",
            default: true,
            name: originalName,
            identityName: originalName,
          },
        ],
      },
    };
    saveElizaConfig(config);
    const brand = { name: "Alpha", bio: ["Product bio"] };
    setAgentHostBridge({ ...getAgentHostBridge(), productCharacter: brand });
    const runtime = new AgentRuntime({
      character: buildProductCharacterFromConfig(config, brand),
      enableAutonomy: false,
      logLevel: "fatal",
    });
    runtimes.push(runtime);
    const model = vi.spyOn(runtime, "useModel").mockImplementation(async () => {
      throw Error("No model in persistence fixture");
    });
    runtime.registerDatabaseAdapter(
      SQLiteDatabaseAdapter.create(
        path.join(root, "state.sqlite"),
        runtime.agentId,
      ),
    );
    await runtime.initialize();
    const vault = await createTestVault({ workDir: path.join(root, "vault") });
    vaults.push(vault);
    const key = "ALPHA_QA_PROFILE_KEY",
      retained = "synthetic-retained";
    await vault.vault.set(profileStorageKey(key, "original"), retained, {
      sensitive: true,
    });
    await vault.vault.set(profileStorageKey(key, "other"), "synthetic-other", {
      sensitive: true,
    });
    await setEntryMeta(vault.vault, key, {
      profiles: [
        { id: "original", label: "Original", createdAt: 1 },
        { id: "other", label: "Other", createdAt: 1 },
      ],
      activeProfile: "other",
    });
    await writeRoutingConfig(vault.vault, {
      rules: [
        {
          keyPattern: key,
          scope: { kind: "agent", agentId: originalScope },
          profileId: "original",
        },
      ],
    });
    const service = new ElizaCharacterPersistenceService(runtime);
    const state = { runtime, agentName: "Alpha", config: loadElizaConfig() };
    const req = new IncomingMessage(new Socket());
    const res = new ServerResponse(req);
    const edit = async (body: Record<string, unknown>) => {
      const handled = await handleCharacterRoutes({
        req,
        res,
        method: "PUT",
        pathname: "/api/character",
        state,
        readJsonBody: async <T extends object>() => body as T,
        json: () => {},
        error: (_res: unknown, message: string) => {
          throw Error(message);
        },
        pickRandomNames: () => [],
        saveConfig: saveElizaConfig,
        validateCharacter: (value: unknown) => CharacterSchema.safeParse(value),
      });
      expect(handled).toBe(true);
    };
    if (mode === "service") {
      const previous = { ...runtime.character };
      runtime.character.bio = ["Updated bio"];
      expect(
        (
          await service.persistCharacter({
            previousCharacter: previous,
            previousName: previous.name,
            nameWasExplicitlyEdited: false,
            source: "agent",
          })
        ).success,
      ).toBe(true);
    } else await edit({ bio: ["Updated bio"] });
    const saved = loadElizaConfig();
    expect(saved.agents?.list?.[0]?.name).toBe(originalName);
    expect(saved.agents?.list?.[0]?.identityName).toBe(originalName);
    expect((await runtime.getAgent(runtime.agentId))?.name).toBe("Alpha");
    const rebuilt = buildProductCharacterFromConfig(saved, brand);
    expect(rebuilt.id).toBe(runtime.agentId);
    expect(rebuilt.name).toBe("Alpha");
    expect(rebuilt.bio).toEqual(["Updated bio"]);
    await applyVaultProfilesForAgent(vault.vault, originalScope);
    expect(process.env[key] === retained).toBe(true);
    syncRuntimeCharacterToChatStateConfig(state);
    saveElizaConfig({ ...state.config, logging: { level: "error" } });
    expect(loadElizaConfig().agents?.list?.[0]?.name).toBe(originalName);
    expect(buildProductCharacterFromConfig(loadElizaConfig(), brand).name).toBe(
      "Alpha",
    );
    // A normal config reload must not copy the product label into canonical storage.
    await handleConfigRoutes({
      req,
      res,
      method: "POST",
      pathname: "/api/config/reload",
      url: new URL("http://localhost/api/config/reload"),
      config: state.config,
      runtime,
      json: () => {},
      error: (_res: unknown, message: string) => {
        throw Error(message);
      },
      isBlockedEnvKey: () => false,
      readJsonBody: async () => null,
      redactConfigSecrets: (value) => value,
      isBlockedObjectKey: () => false,
      stripRedactedPlaceholderValuesDeep: () => {},
      patchTouchesProviderSelection: () => false,
      CONFIG_WRITE_ALLOWED_TOP_KEYS: new Set(),
      resolveMcpServersRejection: async () => null,
      resolveMcpTerminalAuthorizationRejection: () => null,
    });
    expect(runtime.character.name).toBe("Alpha");
    expect(loadElizaConfig().agents?.list?.[0]?.name).toBe(originalName);
    // Even explicitly submitting the existing product label is a real name edit.
    if (mode === "service")
      expect(
        (
          await service.persistCharacter({
            previousName: "Alpha",
            nameWasExplicitlyEdited: true,
            source: "manual",
          })
        ).success,
      ).toBe(true);
    else await edit({ name: "Alpha" });
    expect(loadElizaConfig().agents?.list?.[0]?.name).toBe("Alpha");
    expect(loadElizaConfig().agents?.list?.[0]?.identityName).toBe(
      originalName,
    );
    expect(buildProductCharacterFromConfig(loadElizaConfig(), brand).name).toBe(
      "Alpha",
    );
    if (mode === "service") {
      runtime.character.name = "Beta";
      expect(
        (
          await service.persistCharacter({
            previousName: "Alpha",
            nameWasExplicitlyEdited: true,
            source: "manual",
          })
        ).success,
      ).toBe(true);
    } else await edit({ name: "Beta" });
    expect(buildProductCharacterFromConfig(loadElizaConfig(), brand).name).toBe(
      "Beta",
    );
    await runtime.registerService(ElizaCharacterPersistenceService);
    await runtime.getServiceLoadPromise(
      ElizaCharacterPersistenceService.serviceType,
    );
    const backup = path.join(root, "explicit-character-backup.json");
    await fs.writeFile(
      backup,
      JSON.stringify({ ...runtime.character, name: "Alpha" }),
    );
    const manager = new CharacterFileManager(runtime);
    expect((await manager.restoreFromBackup(backup)).success).toBe(true);
    expect(loadElizaConfig().agents?.list?.[0]?.name).toBe("Alpha");
    expect(runtime.character.name).toBe("Alpha");
    expect(buildProductCharacterFromConfig(loadElizaConfig(), brand).name).toBe(
      "Alpha",
    );
    expect(model).not.toHaveBeenCalled();
  },
);
