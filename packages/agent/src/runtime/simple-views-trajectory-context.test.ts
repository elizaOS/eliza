/**
 * Real PGLite round-trip coverage for the Simple Views context the action
 * planner receives. The real view manifest and prompt-optimization wrapper
 * produce each prompt; a deterministic model boundary keeps the test focused
 * on persisted trajectory evidence rather than model selection.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { fuzzystrmatch } from "@electric-sql/pglite/contrib/fuzzystrmatch";
import { vector } from "@electric-sql/pglite/vector";
import { AgentRuntime, runWithTrajectoryContext } from "@elizaos/core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { simpleViewsPlugin } from "../../../../plugins/plugin-simple-views/src/plugin.ts";
import { DatabaseMigrationService } from "../../../../plugins/plugin-sql/src/migration-service.ts";
import { PgliteDatabaseAdapter } from "../../../../plugins/plugin-sql/src/pglite/adapter.ts";
import * as sqlSchema from "../../../../plugins/plugin-sql/src/schema/index.ts";
import type { DrizzleDatabase } from "../../../../plugins/plugin-sql/src/types.ts";
import {
  registerPluginViews,
  unregisterPluginViews,
} from "../api/views-registry.ts";
import { installPromptOptimizations } from "./prompt-optimization.ts";
import { installDatabaseTrajectoryLogger } from "./trajectory-persistence.ts";
import { flushTrajectoryWrites } from "./trajectory-storage.ts";

import {
  type ActiveViewContext,
  clearActiveViewContext,
  setActiveViewContext,
} from "./view-action-affinity.ts";

interface PersistedLlmCall {
  userPrompt?: string;
  providerMetadata?: {
    promptOptimization?: { transformations?: string[] };
  };
}

interface TrajectoryDetailLike {
  steps?: Array<{ llmCalls?: PersistedLlmCall[] }>;
}

interface TrajectoryLogger {
  startTrajectory: (
    agentId: string,
    options?: { source?: string; metadata?: Record<string, unknown> },
  ) => Promise<string>;
  startStep: (trajectoryId: string) => string;
  getTrajectoryDetail: (
    trajectoryId: string,
  ) => Promise<TrajectoryDetailLike | null>;
  flushWriteQueue?: () => Promise<void>;
}

const SIMPLE_VIEWS_PACKAGE_DIR = fileURLToPath(
  new URL("../../../../plugins/plugin-simple-views/", import.meta.url),
);

const BASE_PLANNER_PROMPT = [
  "message:user:",
  "Use the view that is already open.",
  "",
  "# Available Actions",
  "- VIEWS: manage and interact with registered views",
  "- REPLY: answer without changing the view",
].join("\n");

let runtime: AgentRuntime;
let pgliteDir: string;
let pglite: PGlite;
const previousPgliteDir = process.env.PGLITE_DATA_DIR;

beforeAll(async () => {
  pgliteDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "eliza-simple-views-trajectory-"),
  );
  process.env.PGLITE_DATA_DIR = pgliteDir;

  runtime = new AgentRuntime({
    character: { name: "SimpleViewsTrajectory" },
    plugins: [],
    logLevel: "warn",
    enableAutonomy: false,
  });

  pglite = new PGlite({
    dataDir: pgliteDir,
    extensions: { fuzzystrmatch, vector },
  });
  let initialized = false;
  const manager = {
    close: async () => pglite.close(),
    ensureSync: async () => undefined,
    getConnection: () => pglite,
    initialize: async () => {
      await pglite.waitReady;
      initialized = true;
    },
    isInitialized: () => initialized,
    isShuttingDown: () => false,
    notifyWrite: () => undefined,
  };
  const adapter = new PgliteDatabaseAdapter(runtime.agentId, manager as never);
  await adapter.init();

  const migrationService = new DatabaseMigrationService();
  await migrationService.initializeWithDatabase(
    adapter.getDatabase() as DrizzleDatabase,
  );
  migrationService.discoverAndRegisterPluginSchemas([
    {
      name: "@elizaos/plugin-sql",
      description: "SQL schema used by the persisted trajectory test",
      schema: sqlSchema,
    },
  ]);
  await migrationService.runAllPluginMigrations();

  runtime.registerDatabaseAdapter(adapter);
  await runtime.initialize({ skipMigrations: true });

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !runtime.getService("trajectories")) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await installDatabaseTrajectoryLogger(runtime);

  unregisterPluginViews(simpleViewsPlugin.name);
  await registerPluginViews(simpleViewsPlugin, SIMPLE_VIEWS_PACKAGE_DIR);

  runtime.useModel = (async () =>
    "planner response") as typeof runtime.useModel;
  installPromptOptimizations(runtime, {});
}, 180_000);

afterEach(() => {
  clearActiveViewContext();
});

afterAll(async () => {
  unregisterPluginViews(simpleViewsPlugin.name);
  clearActiveViewContext();
  try {
    await runtime?.stop();
  } catch {
    // error-policy:J6 test teardown must continue so the temporary database is removed.
  }
  if (previousPgliteDir === undefined) {
    delete process.env.PGLITE_DATA_DIR;
  } else {
    process.env.PGLITE_DATA_DIR = previousPgliteDir;
  }
  if (pgliteDir) {
    fs.rmSync(pgliteDir, { recursive: true, force: true });
  }
});

async function persistPlannerPrompt(
  scenario: string,
  activeView: ActiveViewContext,
): Promise<PersistedLlmCall> {
  const logger = runtime.getService(
    "trajectories",
  ) as unknown as TrajectoryLogger | null;
  if (!logger) throw new Error("trajectories service did not start");

  const trajectoryId = await logger.startTrajectory(runtime.agentId, {
    source: "test",
    metadata: { scenario },
  });
  const stepId = logger.startStep(trajectoryId);
  const clientId = `simple-views-trajectory-${scenario}`;
  setActiveViewContext(activeView, clientId);

  await runWithTrajectoryContext(
    {
      trajectoryId,
      trajectoryStepId: stepId,
      clientId,
      purpose: "planner",
    },
    () =>
      runtime.useModel("ACTION_PLANNER", {
        prompt: BASE_PLANNER_PROMPT,
        tools: [{ name: "VIEWS" }],
      }),
  );

  await flushTrajectoryWrites(runtime);
  await logger.flushWriteQueue?.();

  const detail = await logger.getTrajectoryDetail(trajectoryId);
  const calls = (detail?.steps ?? []).flatMap((step) => step.llmCalls ?? []);
  const persisted = calls.find((call) =>
    call.userPrompt?.includes("# Active View"),
  );
  if (!persisted) {
    throw new Error(
      `active-view planner prompt was not persisted for ${scenario}`,
    );
  }
  return persisted;
}

describe("Simple Views active context -> planner -> persisted trajectory", () => {
  it("persists Notes context with only the Notes capability scope", async () => {
    const call = await persistPlannerPrompt("notes", {
      viewId: "notes",
      viewLabel: "Notes",
      viewType: "gui",
      viewPath: "/notes",
    });
    const prompt = call.userPrompt ?? "";

    expect(prompt).toContain('The user is looking at the "Notes" view');
    expect(prompt).toContain('action="interact" and view="notes"');
    expect(prompt).toContain("create-note");
    expect(prompt).toContain("get-notes");
    expect(prompt).not.toContain('view="simple-calendar"');
    expect(prompt).not.toContain("create-calendar-event");
    expect(
      call.providerMetadata?.promptOptimization?.transformations,
    ).toContain("active-view-awareness:notes");
  });

  it("persists Calendar context with only the Calendar capability scope", async () => {
    const call = await persistPlannerPrompt("calendar", {
      viewId: "simple-calendar",
      viewLabel: "Simple Calendar",
      viewType: "gui",
      viewPath: "/simple-calendar",
    });
    const prompt = call.userPrompt ?? "";

    expect(prompt).toContain(
      'The user is looking at the "Simple Calendar" view',
    );
    expect(prompt).toContain('action="interact" and view="simple-calendar"');
    expect(prompt).toContain("create-calendar-event");
    expect(prompt).toContain("get-calendar-state");
    expect(prompt).not.toContain('view="notes"');
    expect(prompt).not.toContain("create-note");
    expect(
      call.providerMetadata?.promptOptimization?.transformations,
    ).toContain("active-view-awareness:simple-calendar");
  });

  it("persists both independently scoped capability catalogs for a split layout", async () => {
    const call = await persistPlannerPrompt("notes-calendar-split", {
      viewId: "notes",
      viewLabel: "Notes",
      viewType: "gui",
      viewPath: "/notes",
      viewIds: ["notes", "simple-calendar"],
      layout: "horizontal",
      placement: "left",
    });
    const prompt = call.userPrompt ?? "";

    expect(prompt).toContain(
      "Visible panes in the horizontal layout: Notes (notes), Simple Calendar (simple-calendar)",
    );
    expect(prompt).toContain('action="interact" and view="notes"');
    expect(prompt).toContain('action="interact" and view="simple-calendar"');
    expect(prompt).toContain("create-note");
    expect(prompt).toContain("get-notes");
    expect(prompt).toContain("create-calendar-event");
    expect(prompt).toContain("get-calendar-state");
    expect(
      call.providerMetadata?.promptOptimization?.transformations,
    ).toContain("active-view-awareness:notes");
  });
});
