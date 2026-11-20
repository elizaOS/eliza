/**
 * Replays the requests of quint/AppBlockPackageCase.qnt through the
 * production BLOCK target=app handler (runAppBlockHandler) on a PGlite-backed
 * AgentRuntime. The device is registered through the production
 * registerNativeAppBlockerBackend seam and follows the Android ElizaAppBlocker
 * plugin: blockApps stores the trimmed package ids as given
 * (AppBlockerPlugin.kt) and an app is blocked only when its package id is in
 * the stored set exactly (AppBlockerStateStore.isBlocked).
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  type ActionParameters,
  type AgentRuntime,
  type Memory,
  ModelType,
  type UUID,
} from "@elizaos/core";
import {
  type AppBlockerPluginLike,
  registerNativeAppBlockerBackend,
} from "@elizaos/plugin-blocker/services/app-blocker/index";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRealTestRuntime } from "../../../packages/app/test/helpers/real-runtime.ts";
import { runAppBlockHandler } from "../src/actions/app-block.js";

/** One request of the model and what the device stores for it. */
interface ModelCase {
  path: number;
  requested: number[];
  stored: number[];
  started: boolean;
}

// Android package ids are case-sensitive; Slack ships as "com.Slack".
const INSTALLED_APPS = [
  { packageName: "com.Slack", displayName: "Slack" },
  { packageName: "com.instagram.android", displayName: "Instagram" },
];
// The package ids of the model, in order. 5 is not installed.
const IDS = [
  "com.Slack",
  "com.slack",
  "COM.SLACK",
  "com.instagram.android",
  "COM.INSTAGRAM.ANDROID",
  "com.example.missing",
];
// The model names an app in the intent text by its installed id.
const NAMED_APPS: Record<number, string> = { 0: "Slack", 3: "Instagram" };
// 1 planner packageNames, 2 apps named in the intent, 3 planning model.
const PATHS = [
  "explicit package ids",
  "apps named in the intent",
  "planner package ids",
];

const DEFAULT_CASES: ModelCase[] = [
  { path: 1, requested: [0], stored: [0], started: true },
  { path: 1, requested: [1], stored: [0], started: true },
  { path: 1, requested: [2, 0], stored: [0], started: true },
  { path: 1, requested: [5], stored: [5], started: true },
  { path: 2, requested: [0], stored: [0], started: true },
  { path: 2, requested: [3, 0], stored: [0, 3], started: true },
  { path: 3, requested: [0], stored: [0], started: true },
  { path: 3, requested: [1, 4], stored: [0, 3], started: true },
  { path: 3, requested: [5], stored: [], started: false },
];

const casesFile = process.env.ELIZA_APP_BLOCK_PACKAGE_CASE_MODEL_CASES;
const cases: ModelCase[] = casesFile
  ? JSON.parse(readFileSync(casesFile, "utf8"))
  : DEFAULT_CASES;

/** Android ElizaAppBlocker plugin semantics behind the production seam. */
class AndroidAppBlocker {
  stored: string[] = [];
  blockCalls = 0;

  readonly plugin: AppBlockerPluginLike = {
    checkPermissions: async () => ({ status: "granted", canRequest: false }),
    requestPermissions: async () => ({ status: "granted", canRequest: false }),
    getInstalledApps: async () => ({ apps: INSTALLED_APPS }),
    selectApps: async () => ({ apps: [], cancelled: true }),
    blockApps: async (options) => {
      this.blockCalls += 1;
      const packageNames = [
        ...new Set(
          (options.packageNames ?? [])
            .map((value) => value.trim())
            .filter((value) => value.length > 0),
        ),
      ].sort();
      if (packageNames.length === 0) {
        return {
          success: false,
          endsAt: null,
          error: "Select at least one Android app to block.",
          blockedCount: 0,
        };
      }
      this.stored = packageNames;
      return { success: true, endsAt: null, blockedCount: packageNames.length };
    },
    unblockApps: async () => {
      this.stored = [];
      return { success: true };
    },
    getStatus: async () => ({
      available: true,
      active: this.stored.length > 0,
      platform: "android",
      engine: "usage-stats-overlay",
      blockedCount: this.stored.length,
      blockedPackageNames: [...this.stored],
      endsAt: null,
      permissionStatus: "granted",
    }),
  };

  /** AppBlockerStateStore.isBlocked: the foreground id must match exactly. */
  isBlocked(packageName: string): boolean {
    return this.stored.includes(packageName);
  }

  reset(): void {
    this.stored = [];
    this.blockCalls = 0;
  }
}

const OWNER_ID = randomUUID() as UUID;
const device = new AndroidAppBlocker();
let runtime: AgentRuntime;
let cleanup: (() => Promise<void>) | undefined;
let plannerPackageNames: string[] = [];
let plannerCalls = 0;

beforeAll(async () => {
  ({ runtime, cleanup } = await createRealTestRuntime({
    characterName: "Eliza",
  }));
  runtime.setSetting("ELIZA_ADMIN_ENTITY_ID", OWNER_ID);
  // The app-block planning model answers with the case's package ids.
  runtime.registerModel(
    ModelType.TEXT_SMALL,
    async (_runtime, params) => {
      const prompt = String((params as { prompt?: unknown }).prompt ?? "");
      if (!prompt.includes("Plan the app blocking action")) {
        throw new Error("Only the app-block planner may call TEXT_SMALL");
      }
      plannerCalls += 1;
      return JSON.stringify({
        shouldAct: true,
        response: null,
        packageNames: plannerPackageNames,
        durationMinutes: 60,
      });
    },
    "app-block-package-case-planner",
  );
  registerNativeAppBlockerBackend(device.plugin);
}, 120_000);

afterAll(async () => {
  await cleanup?.();
});

function ownerRequest(text: string): Memory {
  return {
    id: randomUUID() as UUID,
    entityId: OWNER_ID,
    agentId: runtime.agentId,
    roomId: randomUUID() as UUID,
    content: { text, source: "test" },
  } as Memory;
}

async function replay(item: ModelCase) {
  device.reset();
  plannerCalls = 0;
  plannerPackageNames =
    item.path === 3 ? item.requested.map((id) => IDS[id]) : [];
  const text =
    item.path === 1
      ? "block the apps I picked"
      : item.path === 2
        ? `block ${item.requested.map((id) => NAMED_APPS[id]).join(" and ")}`
        : "block my work chat";
  const parameters: ActionParameters =
    item.path === 1
      ? { action: "block", packageNames: item.requested.map((id) => IDS[id]) }
      : { action: "block", intent: text };
  const result = await runAppBlockHandler(
    runtime,
    ownerRequest(text),
    undefined,
    {
      parameters,
    },
  );
  return {
    success: result.success,
    text: result.text,
    stored: device.stored.map((id) => IDS.indexOf(id)).sort(),
    blocked: INSTALLED_APPS.filter((app) => device.isBlocked(app.packageName))
      .map((app) => IDS.indexOf(app.packageName))
      .sort(),
    blockCalls: device.blockCalls,
    plannerCalls,
  };
}

describe("app block package case model", () => {
  it.each(PATHS)(
    "replays %s",
    async (name) => {
      const path = PATHS.indexOf(name) + 1;
      const group = cases.filter((item) => item.path === path);
      expect(group.length).toBeGreaterThan(0);
      for (const item of group) {
        const stored = [...item.stored].sort();
        const count = stored.length;
        const actual = await replay(item);
        // A refused request's reply text is not part of the model.
        expect(
          {
            case: item,
            ...actual,
            text: item.started ? actual.text : null,
          },
          JSON.stringify(item),
        ).toEqual({
          case: item,
          success: item.started,
          text: item.started
            ? `Started blocking ${count} app${count !== 1 ? "s" : ""} until you unblock.`
            : null,
          stored,
          // An installed app is blocked when its exact id is stored.
          blocked: stored.filter((id) => id === 0 || id === 3),
          blockCalls: item.started ? 1 : 0,
          plannerCalls: path === 3 ? 1 : 0,
        });
      }
    },
    300_000,
  );
});
