import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCharacterFromConfig, createElizaPlugin } from "@elizaos/agent";
import { AgentRuntime, type Plugin, type UUID } from "@elizaos/core";
import dotenv from "dotenv";
import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIf } from "../../../test/helpers/conditional-tests.ts";
import { ConversationHarness } from "../../../test/helpers/conversation-harness.ts";
import { saveEnv } from "../../../test/helpers/test-utils";
import {
  acceptCanonicalIdentityMerge,
  assertCanonicalIdentityMerged,
  CANONICAL_IDENTITY_PLATFORMS,
  seedCanonicalIdentityFixture,
} from "./helpers/lifeops-identity-merge-fixtures.js";
import {
  getLifeOpsLiveSetupWarnings,
  getSelectedLiveProviderEnv,
  LIVE_PROVIDER_ENV_KEYS,
  LIVE_TESTS_ENABLED,
  selectLifeOpsLiveProvider,
} from "./helpers/lifeops-live-harness.ts";
import { loadPlugin } from "./helpers/lifeops-morning-brief-fixtures.ts";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(testDir, "..");
dotenv.config({ path: path.resolve(packageRoot, ".env") });
dotenv.config({ path: path.resolve(packageRoot, "..", "..", ".env") });

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

const selectedLiveProvider = await selectLifeOpsLiveProvider();
const selectedProviderEnv = getSelectedLiveProviderEnv(selectedLiveProvider, {
  omitOpenAiBaseUrl: true,
});
const SUPPORTED_PROVIDER_NAMES = new Set([
  "cerebras",
  "openai",
  "openrouter",
  "google",
]);
const LIVE_SUITE_ENABLED =
  LIVE_TESTS_ENABLED &&
  selectedLiveProvider !== null &&
  SUPPORTED_PROVIDER_NAMES.has(selectedLiveProvider.name);

if (!LIVE_SUITE_ENABLED) {
  const warnings = [
    ...getLifeOpsLiveSetupWarnings(selectedLiveProvider),
    selectedLiveProvider &&
    !SUPPORTED_PROVIDER_NAMES.has(selectedLiveProvider.name)
      ? `selected provider "${selectedLiveProvider.name}" does not support this suite; use Cerebras, OpenAI, OpenRouter, or Google`
      : null,
  ].filter((entry): entry is string => Boolean(entry));
  console.info(
    `[assistant-user-journeys-identity-merge-live] suite skipped until setup is complete: ${warnings.join(" | ")}`,
  );
}

describeIf(LIVE_SUITE_ENABLED)(
  "Live: canonical identity merge assistant journey",
  () => {
    let runtime: AgentRuntime;
    let envBackup: { restore: () => void };
    let harness: ConversationHarness;
    let ownerId: UUID;

    const workspaceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "eliza-identity-merge-workspace-"),
    );
    const pgliteDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "eliza-identity-merge-pglite-"),
    );
    const stateDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "eliza-identity-merge-state-"),
    );

    beforeAll(async () => {
      envBackup = saveEnv(
        ...LIVE_PROVIDER_ENV_KEYS,
        "PGLITE_DATA_DIR",
        "ELIZA_STATE_DIR",
      );
      process.env.PGLITE_DATA_DIR = pgliteDir;
      process.env.ELIZA_STATE_DIR = stateDir;
      process.env.LOG_LEVEL = process.env.ELIZA_E2E_LOG_LEVEL ?? "error";

      for (const key of LIVE_PROVIDER_ENV_KEYS) {
        delete process.env[key];
      }
      Object.assign(process.env, selectedProviderEnv);

      ownerId = crypto.randomUUID() as UUID;

      const character = buildCharacterFromConfig({});
      character.settings = {
        ...character.settings,
        ELIZA_ADMIN_ENTITY_ID: ownerId,
      };
      character.secrets = selectedProviderEnv;

      const sqlPlugin = await loadPlugin("@elizaos/plugin-sql");
      const providerPlugin = selectedLiveProvider
        ? await loadPlugin(selectedLiveProvider.plugin)
        : null;
      if (!sqlPlugin || !providerPlugin) {
        throw new Error("Required live plugins were not available.");
      }

      runtime = new AgentRuntime({
        character,
        plugins: [
          providerPlugin as Plugin,
          createElizaPlugin({
            agentId: "main",
            workspaceDir,
          }),
        ],
        conversationLength: 24,
        enableAutonomy: false,
        logLevel: "error",
      });

      await runtime.registerPlugin(sqlPlugin as Plugin);
      if (runtime.adapter && !(await runtime.adapter.isReady())) {
        await runtime.adapter.init();
      }
      await runtime.initialize();
      await (
        runtime as AgentRuntime & {
          enableRelationships?: () => Promise<void>;
        }
      ).enableRelationships?.();

      const trajectoryService = runtime.getService("trajectories") as
        | {
            logLlmCall?: (...args: unknown[]) => unknown;
            setEnabled?: (enabled: boolean) => void;
            updateLatestLlmCall?: (...args: unknown[]) => unknown;
          }
        | undefined;
      if (trajectoryService) {
        trajectoryService.setEnabled?.(false);
        trajectoryService.logLlmCall = () => {};
        trajectoryService.updateLatestLlmCall = async () => {};
      }

      const fixture = await seedCanonicalIdentityFixture({
        runtime,
        seedKey: "live-identity-merge",
        ownerId,
        ownerName: "Shaw",
        personName: "Priya Rao",
      });
      await acceptCanonicalIdentityMerge(runtime, fixture);

      harness = new ConversationHarness(runtime, {
        userId: ownerId,
        userName: "Shaw",
        defaultTimeoutMs: 120_000,
        actionSettleMs: 1000,
      });
      await harness.setup();
    }, 240_000);

    afterAll(async () => {
      try {
        await runtime?.stop();
      } catch {}
      try {
        await runtime?.close();
      } catch {}
      envBackup?.restore();
      fs.rmSync(workspaceDir, { recursive: true, force: true });
      fs.rmSync(pgliteDir, { recursive: true, force: true });
      fs.rmSync(stateDir, { recursive: true, force: true });
    });

    it("surfaces one person across Gmail, Signal, Telegram, and WhatsApp without duplicating the contact", async () => {
      const turn = await harness.send(
        "Show me everything Priya Rao has sent me recently across Gmail, Signal, Telegram, and WhatsApp. Treat it as one person and group the context by platform.",
      );

      const mergeFailure = await assertCanonicalIdentityMerged({
        runtime,
        personName: "Priya Rao",
        expectedPlatforms: CANONICAL_IDENTITY_PLATFORMS,
      });
      expect(mergeFailure).toBeUndefined();

      const text = normalizeText(turn.responseText);
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toMatch(
        /something (?:went wrong|flaked)|please try again|try again in a sec/i,
      );
    }, 240_000);
  },
);
