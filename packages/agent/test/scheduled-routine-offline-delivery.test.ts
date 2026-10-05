/**
 * Alpha routines (#31022): a routine that fires while the phone is offline
 * lands in durable chat history exactly once and is served on reconnect.
 *
 * Real composition: SQLite AgentRuntime, the scheduling plugin (runner
 * service, durable record store, boot seeder, REST routes), the personal
 * assistant's production scheduled-task dispatcher (in_app → assistant event
 * stream), and the agent HTTP server, whose agent-event subscription persists
 * the routine into the conversation. No WebSocket client ever connects.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentEventService, createCharacter } from "@elizaos/core";
import { installHttpPluginLifecycle } from "@elizaos/host/protocol";
import {
  ALPHA_ROUTINES_ENABLE_TRIGGERS,
  ALPHA_ROUTINES_IDEMPOTENCY_KEYS,
  createSchedulingRecordStores,
  getSchedulingRecordStore,
  isScheduledTaskDue,
  OWNER_LOCAL_TZ,
  registerScheduledTaskRunnerDeps,
  runStandaloneSchedulingTick,
  SCHEDULING_DEFAULT_PACKS_SETTING,
  type ScheduledTask,
  type ScheduledTaskRunnerService,
  schedulingPlugin,
  waitForScheduledTaskRunnerService,
} from "@elizaos/plugin-scheduling";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { expect, it, vi } from "vitest";
import { createAssistantPlugin } from "../../../plugins/plugin-assistant/src/index.ts";
import { createProductionScheduledTaskDispatcher } from "../../../plugins/plugin-personal-assistant/src/lifeops/scheduled-task/runtime-wiring.ts";
import { startApiServer } from "../src/api/server.ts";

const OWNER_TZ = "America/New_York";
const ROUTINE_SOURCE = "lifeops-scheduled-task";

interface HistoryMessage {
  id: string;
  role: string;
  text: string;
  source?: string;
}

it("delivers a routine fired while offline exactly once on reconnect", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "eliza-routine-"));
  for (const [key, value] of Object.entries({
    ELIZA_STATE_DIR: directory,
    ELIZA_CONFIG_PATH: path.join(directory, "config.json"),
    ELIZA_PERSIST_CONFIG_PATH: path.join(directory, "config.json"),
    ELIZA_API_BIND_HOST: "127.0.0.1",
    ELIZA_API_TOKEN: "",
    ELIZA_REQUIRE_LOCAL_AUTH: "0",
  }))
    vi.stubEnv(key, value);
  const runtime = createSQLiteTestRuntime({
    plugins: [
      createAssistantPlugin(),
      // The agent host plugin's event bus (see src/runtime/eliza-plugin.ts).
      {
        name: "agent-event-host",
        description: "Agent event bus",
        services: [AgentEventService],
      },
      { ...schedulingPlugin, schema: undefined, dependencies: [] },
    ],
    character: createCharacter({
      name: "AlphaRoutines",
      settings: { [SCHEDULING_DEFAULT_PACKS_SETTING]: "alpha-routines" },
    }),
    logLevel: "fatal",
    enableAutonomy: false,
  });
  // Consumer host wiring as the personal assistant installs it: its production
  // dispatcher over the scheduling-owned durable store, owner facts carrying
  // the owner's timezone.
  registerScheduledTaskRunnerDeps(runtime, (rt, agentId) => {
    const recordStore = getSchedulingRecordStore(rt);
    if (!recordStore) throw new Error("SQLite record store is required");
    const stores = createSchedulingRecordStores(recordStore, agentId);
    return {
      store: stores.store,
      logStore: stores.logStore,
      dispatcher: createProductionScheduledTaskDispatcher({ runtime: rt }),
      ownerFacts: () => ({ timezone: OWNER_TZ }),
      globalPause: { current: async () => ({ active: false }) },
      activity: { hasSignalSince: () => false },
      subjectStore: { wasUpdatedSince: () => false },
    };
  });
  let server: Awaited<ReturnType<typeof startApiServer>> | undefined;
  try {
    await runtime.initialize();
    installHttpPluginLifecycle(runtime);
    const service: ScheduledTaskRunnerService =
      await waitForScheduledTaskRunnerService(runtime);
    const runnerAt = (now: Date) =>
      service.getRunner({ agentId: runtime.agentId, now: () => now });

    // Seeded once through the default-pack mechanism, all disabled.
    const alphaKeys = Object.values(ALPHA_ROUTINES_IDEMPOTENCY_KEYS);
    let alpha: ScheduledTask[] = [];
    await vi.waitFor(
      async () => {
        alpha = (await runnerAt(new Date()).list()).filter((task) =>
          alphaKeys.includes(task.idempotencyKey as never),
        );
        expect(alpha).toHaveLength(alphaKeys.length);
      },
      { timeout: 30_000 },
    );
    for (const task of alpha) {
      expect(task.trigger).toEqual({ kind: "manual" });
      expect(task.metadata).toMatchObject({
        defaultPack: "alpha-routines",
        pausedByDefault: true,
        enableTrigger: { kind: "cron", tz: OWNER_LOCAL_TZ },
      });
    }
    const brief = alpha.find(
      (task) =>
        task.idempotencyKey === ALPHA_ROUTINES_IDEMPOTENCY_KEYS.morningBrief,
    );
    if (!brief) throw new Error("morning brief routine was not seeded");

    // The consumer host owns the tick; the standalone driver defers to it.
    expect((await runStandaloneSchedulingTick(runtime)).skipped).toBe(
      "consumer_host",
    );

    server = await startApiServer({
      port: 0,
      runtime,
      skipDeferredStartupWork: true,
    });
    const base = `http://127.0.0.1:${server.port}`;
    const request = async (route: string, init?: RequestInit) => {
      const response = await fetch(`${base}${route}`, {
        ...init,
        headers: { "content-type": "application/json" },
      });
      const data = await response.json();
      expect(response.status, JSON.stringify(data)).toBeLessThan(300);
      return data;
    };
    const { conversation } = await request("/api/conversations", {
      method: "POST",
      body: JSON.stringify({ title: "Alpha phone" }),
    });
    const routineHistory = async (): Promise<HistoryMessage[]> => {
      const { messages } = (await request(
        `/api/conversations/${conversation.id}/messages`,
      )) as { messages: HistoryMessage[] };
      return messages.filter((message) => message.source === ROUTINE_SOURCE);
    };

    // The production tick's due-then-claim step (PA scheduler.ts), limited
    // to the enabled routine so unrelated rows cannot mask its outcome.
    const tick = async (now: Date) => {
      const runner = runnerAt(now);
      const ownerFacts = await runner.resolveOwnerFacts();
      const outcomes: string[] = [];
      for (const task of await runner.list()) {
        const decision = await isScheduledTaskDue(task, { now, ownerFacts });
        if (!decision.due || task.taskId !== brief.taskId) continue;
        const fire = await runner.fireWithResult(task.taskId, {
          cause: "automatic",
          allowTerminalRefire: true,
        });
        outcomes.push(fire.kind);
      }
      return outcomes;
    };

    // Disabled: a manual routine is never due, even days later.
    const farFuture = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    expect(
      await runnerAt(farFuture).resolveDueDecision(
        (await runnerAt(farFuture).list()).find(
          (task) => task.taskId === brief.taskId,
        ) as ScheduledTask,
      ),
    ).toMatchObject({ due: false, reason: "manual" });
    expect(await tick(farFuture)).toEqual([]);
    expect(await routineHistory()).toEqual([]);

    // Enable through the real REST edit path with the pack's owner-local cron.
    const { task: enabled } = (await request(
      `/api/lifeops/scheduled-tasks/${brief.taskId}/edit`,
      {
        method: "POST",
        body: JSON.stringify({
          trigger: ALPHA_ROUTINES_ENABLE_TRIGGERS.morningBrief,
        }),
      },
    )) as { task: ScheduledTask };
    expect(enabled.trigger).toEqual({
      kind: "cron",
      expression: "0 8 * * *",
      tz: OWNER_LOCAL_TZ,
    });
    const nextFireAt = await runnerAt(new Date()).resolveNextFireAt(enabled);
    if (!nextFireAt) throw new Error("enabled routine has no next fire time");
    const ownerHour = new Intl.DateTimeFormat("en-US", {
      timeZone: OWNER_TZ,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(nextFireAt));
    expect(ownerHour).toBe("08:00");

    // Phone offline (no WebSocket client). The occurrence becomes due and two
    // overlapping ticks race for it, then a later tick re-examines it.
    const fireAt = new Date(Date.parse(nextFireAt) + 30_000);
    const [first, second] = await Promise.all([tick(fireAt), tick(fireAt)]);
    expect([...first, ...second].filter((kind) => kind === "fired")).toEqual([
      "fired",
    ]);
    expect(await tick(new Date(fireAt.getTime() + 60_000))).toEqual([]);

    // Reconnect: the client reloads history (twice, as a flaky reconnect
    // would) and sees exactly one routine message with a stable id.
    let delivered: HistoryMessage[] = [];
    await vi.waitFor(
      async () => {
        delivered = await routineHistory();
        expect(delivered).toHaveLength(1);
      },
      { timeout: 30_000 },
    );
    expect(delivered[0]).toMatchObject({ role: "assistant" });
    expect(delivered[0]?.text.trim().length).toBeGreaterThan(0);
    const reloaded = await routineHistory();
    expect(reloaded).toEqual(delivered);
  } finally {
    await server?.close();
    await runtime.stop();
    await runtime.close();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);
