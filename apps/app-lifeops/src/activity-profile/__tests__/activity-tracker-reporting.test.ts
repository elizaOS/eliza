import { PGlite } from "@electric-sql/pglite";
import type { IAgentRuntime } from "@elizaos/core";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  insertActivityEvent,
  listActivityEvents,
} from "../activity-tracker-repo.js";
import {
  getActivityReport,
  getTimeOnApp,
} from "../activity-tracker-reporting.js";

interface Harness {
  runtime: IAgentRuntime;
  pgClient: PGlite;
  close: () => Promise<void>;
}

const BOOTSTRAP = `CREATE TABLE IF NOT EXISTS life_activity_events (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  event_kind TEXT NOT NULL,
  bundle_id TEXT NOT NULL,
  app_name TEXT NOT NULL,
  window_title TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
)`;

const AGENT_ID = "00000000-0000-0000-0000-00000000aaaa";

async function createHarness(): Promise<Harness> {
  const pgClient = new PGlite();
  const db = drizzle(pgClient);
  await db.execute(sql.raw(BOOTSTRAP));
  const runtime = {
    agentId: AGENT_ID,
    adapter: { db },
  } as unknown as IAgentRuntime;
  return {
    runtime,
    pgClient,
    close: async () => {
      await pgClient.close();
    },
  };
}

async function seed(
  runtime: IAgentRuntime,
  events: Array<{
    tsIso: string;
    kind: "activate" | "deactivate";
    bundleId: string;
    appName: string;
    windowTitle?: string | null;
  }>,
) {
  for (const e of events) {
    await insertActivityEvent(runtime, {
      agentId: AGENT_ID,
      observedAt: e.tsIso,
      eventKind: e.kind,
      bundleId: e.bundleId,
      appName: e.appName,
      windowTitle: e.windowTitle ?? null,
    });
  }
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

describe("activity-tracker reporting (pglite)", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it("inserts and lists activity events", async () => {
    const now = Date.now();
    await seed(h.runtime, [
      {
        tsIso: iso(now - 60_000),
        kind: "activate",
        bundleId: "com.apple.Safari",
        appName: "Safari",
      },
    ]);
    const rows = await listActivityEvents(
      h.runtime,
      AGENT_ID,
      iso(now - 120_000),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.bundleId).toBe("com.apple.Safari");
    expect(rows[0]?.eventKind).toBe("activate");
  });

  it("computes per-app dwell time using next-event anchoring", async () => {
    const now = Date.now();
    // Safari focused at T-30m, VS Code at T-20m, Safari again at T-10m, still
    // active now. Expected: Safari = 10m + 10m (up to now) = 20m. VS Code = 10m.
    await seed(h.runtime, [
      {
        tsIso: iso(now - 30 * 60_000),
        kind: "activate",
        bundleId: "com.apple.Safari",
        appName: "Safari",
      },
      {
        tsIso: iso(now - 20 * 60_000),
        kind: "activate",
        bundleId: "com.microsoft.VSCode",
        appName: "VS Code",
      },
      {
        tsIso: iso(now - 10 * 60_000),
        kind: "activate",
        bundleId: "com.apple.Safari",
        appName: "Safari",
      },
    ]);

    const report = await getActivityReport(h.runtime, AGENT_ID, {
      windowMs: 60 * 60_000,
      nowMs: now,
    });

    expect(report.apps).toHaveLength(2);
    const safari = report.apps.find((a) => a.appName === "Safari");
    const vscode = report.apps.find((a) => a.appName === "VS Code");
    expect(safari?.totalMs).toBe(20 * 60_000);
    expect(vscode?.totalMs).toBe(10 * 60_000);
    expect(report.totalMs).toBe(30 * 60_000);
    // Top app is Safari (20m).
    expect(report.apps[0]?.appName).toBe("Safari");
  });

  it("terminates an app interval on deactivate (no ghost time)", async () => {
    const now = Date.now();
    await seed(h.runtime, [
      {
        tsIso: iso(now - 20 * 60_000),
        kind: "activate",
        bundleId: "com.microsoft.VSCode",
        appName: "VS Code",
      },
      {
        tsIso: iso(now - 15 * 60_000),
        kind: "deactivate",
        bundleId: "com.microsoft.VSCode",
        appName: "VS Code",
      },
    ]);
    const report = await getActivityReport(h.runtime, AGENT_ID, {
      windowMs: 60 * 60_000,
      nowMs: now,
    });
    const vscode = report.apps.find((a) => a.appName === "VS Code");
    expect(vscode?.totalMs).toBe(5 * 60_000);
    // Total should be exactly the VS Code dwell — no ghost interval extending
    // to `now`.
    expect(report.totalMs).toBe(5 * 60_000);
  });

  it("getTimeOnApp matches by bundle id and by app name", async () => {
    const now = Date.now();
    await seed(h.runtime, [
      {
        tsIso: iso(now - 20 * 60_000),
        kind: "activate",
        bundleId: "com.microsoft.VSCode",
        appName: "VS Code",
      },
      {
        tsIso: iso(now - 10 * 60_000),
        kind: "activate",
        bundleId: "com.apple.Safari",
        appName: "Safari",
      },
    ]);

    const byBundle = await getTimeOnApp(
      h.runtime,
      AGENT_ID,
      "com.microsoft.VSCode",
      { windowMs: 60 * 60_000, nowMs: now },
    );
    expect(byBundle.totalMs).toBe(10 * 60_000);
    expect(byBundle.matchedBy).toBe("bundleId");

    const byName = await getTimeOnApp(h.runtime, AGENT_ID, "Safari", {
      windowMs: 60 * 60_000,
      nowMs: now,
    });
    expect(byName.totalMs).toBe(10 * 60_000);
    expect(byName.matchedBy).toBe("appName");

    const miss = await getTimeOnApp(h.runtime, AGENT_ID, "Nonexistent", {
      windowMs: 60 * 60_000,
      nowMs: now,
    });
    expect(miss.totalMs).toBe(0);
    expect(miss.matchedBy).toBe("none");
  });

  it("does not persist sample window titles when redactor is on", async () => {
    const now = Date.now();
    await seed(h.runtime, [
      {
        tsIso: iso(now - 5 * 60_000),
        kind: "activate",
        bundleId: "com.apple.mail",
        appName: "Mail",
        windowTitle: "Inbox — alice@example.com",
      },
    ]);
    const report = await getActivityReport(h.runtime, AGENT_ID, {
      windowMs: 60 * 60_000,
      nowMs: now,
      redactor: { enabled: true },
    });
    const mail = report.apps.find((a) => a.appName === "Mail");
    expect(mail?.totalMs).toBe(5 * 60_000);
    expect(mail?.sampleWindowTitles).toEqual([]);
  });

  it("does not expose raw sample window titles when redactor is off", async () => {
    const now = Date.now();
    await seed(h.runtime, [
      {
        tsIso: iso(now - 5 * 60_000),
        kind: "activate",
        bundleId: "com.apple.mail",
        appName: "Mail",
        windowTitle: "Inbox — alice@example.com",
      },
    ]);
    const report = await getActivityReport(h.runtime, AGENT_ID, {
      windowMs: 60 * 60_000,
      nowMs: now,
      redactor: { enabled: false },
    });
    const mail = report.apps.find((a) => a.appName === "Mail");
    expect(mail?.totalMs).toBe(5 * 60_000);
    expect(mail?.sampleWindowTitles).toEqual([]);
  });

  it("returns empty report when no events exist", async () => {
    const now = Date.now();
    const report = await getActivityReport(h.runtime, AGENT_ID, {
      windowMs: 60 * 60_000,
      nowMs: now,
    });
    expect(report.apps).toEqual([]);
    expect(report.totalMs).toBe(0);
  });
});
