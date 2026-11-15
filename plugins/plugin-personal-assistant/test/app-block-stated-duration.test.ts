/**
 * Replays the requests of quint/AppBlockStatedDuration.qnt through the
 * production BLOCK target=app handler (runAppBlockHandler) on a PGlite-backed
 * AgentRuntime. The device is registered through the production
 * registerNativeAppBlockerBackend seam and follows the Android ElizaAppBlocker
 * plugin (AppBlockerPlugin.kt, parseDurationMinutes): the number is cut to
 * whole minutes, and a missing value or a value below one minute keeps the
 * block with no end time.
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

/** One request of the model and the block length the device keeps. */
interface ModelCase {
  path: number;
  param: number;
  phrase: number;
  plan: number;
  minutes: number;
}

const INSTAGRAM = "com.instagram.android";
const INSTALLED_APPS = [
  { packageName: INSTAGRAM, displayName: "Instagram" },
  { packageName: "com.google.android.youtube", displayName: "YouTube" },
];
// The action planner's durationMinutes: omitted, 45, 0.4.
const PARAMS: Array<number | undefined> = [undefined, 45, 0.4];
// What the message says about the length.
const PHRASES = [
  "",
  " for 2 hours",
  " for 90 minutes",
  " for 1.5 hours",
  " until I unblock it",
];
// The planning model's durationMinutes: omitted, 60, 0.4.
const PLANS: Array<number | undefined> = [undefined, 60, 0.4];
// 1 planner packageNames, 2 the app named in the intent, 3 planning model.
const PATHS = [
  "explicit package ids",
  "the app named in the intent",
  "planner package ids",
];
// The device reports the end time from a fixed start.
const START_MS = Date.UTC(2026, 10, 15, 6, 0, 0);

const DEFAULT_CASES: ModelCase[] = [
  { path: 1, param: 0, phrase: 1, plan: 0, minutes: 120 },
  { path: 1, param: 1, phrase: 1, plan: 0, minutes: 45 },
  { path: 1, param: 0, phrase: 0, plan: 0, minutes: 0 },
  { path: 2, param: 0, phrase: 3, plan: 0, minutes: 90 },
  { path: 2, param: 2, phrase: 0, plan: 0, minutes: 1 },
  { path: 2, param: 0, phrase: 4, plan: 0, minutes: 0 },
  { path: 3, param: 0, phrase: 0, plan: 1, minutes: 60 },
  { path: 3, param: 0, phrase: 2, plan: 1, minutes: 90 },
  { path: 3, param: 0, phrase: 0, plan: 2, minutes: 1 },
];

const casesFile = process.env.ELIZA_APP_BLOCK_STATED_DURATION_MODEL_CASES;
const cases: ModelCase[] = casesFile
  ? JSON.parse(readFileSync(casesFile, "utf8"))
  : DEFAULT_CASES;

/** Android ElizaAppBlocker plugin semantics behind the production seam. */
class AndroidAppBlocker {
  stored: string[] = [];
  minutes: number | null = null;
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
      // parseDurationMinutes: Number.toLong() cuts toward zero, and only a
      // value above 0 sets an end time.
      const raw = options.durationMinutes;
      const whole =
        typeof raw === "number" && Number.isFinite(raw) ? Math.trunc(raw) : 0;
      this.minutes = whole > 0 ? whole : null;
      this.stored = packageNames;
      return {
        success: true,
        endsAt:
          this.minutes === null
            ? null
            : new Date(START_MS + this.minutes * 60_000).toISOString(),
        blockedCount: packageNames.length,
      };
    },
    unblockApps: async () => {
      this.stored = [];
      this.minutes = null;
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

  reset(): void {
    this.stored = [];
    this.minutes = null;
    this.blockCalls = 0;
  }
}

const OWNER_ID = randomUUID() as UUID;
const device = new AndroidAppBlocker();
let runtime: AgentRuntime;
let cleanup: (() => Promise<void>) | undefined;
let plannerDuration: number | undefined;
let plannerCalls = 0;

beforeAll(async () => {
  ({ runtime, cleanup } = await createRealTestRuntime({
    characterName: "Eliza",
  }));
  runtime.setSetting("ELIZA_ADMIN_ENTITY_ID", OWNER_ID);
  // The app-block planning model selects Instagram with the case's length.
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
        packageNames: [INSTAGRAM],
        ...(plannerDuration === undefined
          ? {}
          : { durationMinutes: plannerDuration }),
      });
    },
    "app-block-stated-duration-planner",
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
  plannerDuration = PLANS[item.plan];
  const phrase = PHRASES[item.phrase];
  const text =
    item.path === 1
      ? `block the apps I picked${phrase}`
      : item.path === 2
        ? `block Instagram${phrase}`
        : `block my photo feed${phrase}`;
  const durationMinutes = PARAMS[item.param];
  const parameters: ActionParameters = {
    action: "block",
    ...(item.path === 1 ? { packageNames: [INSTAGRAM] } : { intent: text }),
    ...(durationMinutes === undefined ? {} : { durationMinutes }),
  };
  const result = await runAppBlockHandler(
    runtime,
    ownerRequest(text),
    undefined,
    { parameters },
  );
  return {
    success: result.success,
    text: result.text,
    stored: [...device.stored],
    minutes: device.minutes ?? 0,
    blockCalls: device.blockCalls,
    plannerCalls,
  };
}

describe("app block stated duration model", () => {
  it.each(PATHS)(
    "replays %s",
    async (name) => {
      const path = PATHS.indexOf(name) + 1;
      const group = cases.filter((item) => item.path === path);
      expect(group.length).toBeGreaterThan(0);
      for (const item of group) {
        const actual = await replay(item);
        const until =
          item.minutes > 0
            ? `until ${new Date(START_MS + item.minutes * 60_000).toISOString()}`
            : "until you unblock";
        expect({ case: item, ...actual }, JSON.stringify(item)).toEqual({
          case: item,
          success: true,
          text: `Started blocking 1 app ${until}.`,
          stored: [INSTAGRAM],
          minutes: item.minutes,
          blockCalls: 1,
          plannerCalls: path === 3 ? 1 : 0,
        });
      }
    },
    300_000,
  );
});
