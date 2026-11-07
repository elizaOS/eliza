/**
 * Integration tests for the scheduled-tasks REST surface through the
 * PRODUCTION adapter seam (`buildSchedulingRoutes` → `plugin-routes.ts`):
 * real `IncomingMessage` streams, the real core `readJsonBody` reader, the
 * real `ScheduledTaskRunnerService` runner resolution, and host-injected
 * in-memory stores (the documented `registerScheduledTaskRunnerDeps`
 * injection point). No `SchedulingRouteContext` mock — this is the suite that
 * pins the reader contracts the route's framing gates depend on (#23977 item 3).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { IncomingMessage as NodeIncomingMessage } from "node:http";
import { Socket } from "node:net";
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  createInMemoryScheduledTaskStore,
  type ScheduledTaskStore,
  TestNoopScheduledTaskDispatcher,
} from "../scheduled-task/runner.js";
import {
  registerScheduledTaskRunnerDeps,
  ScheduledTaskRunnerService,
} from "../scheduled-task/runner-service.js";
import { createInMemoryScheduledTaskLogStore } from "../scheduled-task/state-log.js";
import type {
  ScheduledTask,
  ScheduledTaskLogEntry,
} from "../scheduled-task/types.js";
import { buildSchedulingRoutes } from "./plugin-routes.js";

const AGENT_ID = "seam-test-agent";

interface RecordedResponse {
  statusCode: number;
  body: string;
  headers: Record<string, string | number | readonly string[]>;
}

function responseRecorder(): ServerResponse & RecordedResponse {
  return {
    statusCode: 200,
    body: "",
    headers: {},
    setHeader(
      this: RecordedResponse,
      name: string,
      value: string | number | readonly string[],
    ) {
      this.headers[name.toLowerCase()] = value;
      return this as unknown as ServerResponse;
    },
    end(this: RecordedResponse, chunk?: unknown) {
      if (chunk !== undefined) this.body += String(chunk);
      return this as unknown as ServerResponse;
    },
  } as unknown as ServerResponse & RecordedResponse;
}

function jsonRequest(
  method: string,
  url: string,
  body?: string,
  headers: Record<string, string> = {},
): IncomingMessage {
  const socket = new Socket();
  Object.defineProperty(socket, "remoteAddress", {
    value: "127.0.0.1",
    configurable: true,
  });
  const req = new NodeIncomingMessage(socket);
  req.method = method;
  req.url = url;
  req.headers = { "content-type": "application/json", ...headers };
  // Push after the socket attaches so the handler's stream listeners drain
  // the buffered chunks once attached (PassThrough-free, real IncomingMessage).
  if (body !== undefined) req.push(body);
  req.push(null);
  return req;
}

interface SeamHarness {
  handler: (
    req: IncomingMessage,
    res: ServerResponse,
    runtime: IAgentRuntime,
  ) => Promise<void>;
  runtime: IAgentRuntime;
  store: ScheduledTaskStore;
  service: ScheduledTaskRunnerService;
  logRows: (taskId: string) => Promise<ScheduledTaskLogEntry[]>;
  stop: () => Promise<void>;
}

/** One live service per seam; stopped after each test so no runner leaks. */
const startedServices: { stop(): Promise<void> }[] = [];

async function makeSeam(): Promise<SeamHarness> {
  const store = createInMemoryScheduledTaskStore();
  const logStore = createInMemoryScheduledTaskLogStore();
  const runtime = {
    agentId: AGENT_ID,
    getService: () => null,
    reportError: () => {},
  } as unknown as IAgentRuntime;
  registerScheduledTaskRunnerDeps(runtime, () => ({
    store,
    logStore,
    dispatcher: TestNoopScheduledTaskDispatcher,
    ownerFacts: () => ({}),
    globalPause: { current: async () => ({ active: false }) },
    activity: { hasSignalSince: () => false },
    subjectStore: { wasUpdatedSince: () => false },
  }));
  const service = await ScheduledTaskRunnerService.start(runtime);
  startedServices.push(service);
  const runtimeWithService = {
    ...runtime,
    getService: (type: string) =>
      type === ScheduledTaskRunnerService.serviceType ? service : null,
  } as unknown as IAgentRuntime;
  // buildSchedulingRoutes returns one Route[] sharing a single handler; any
  // entry's handler is the seam under test.
  const [route] = buildSchedulingRoutes();
  if (!route || typeof route.handler !== "function") {
    throw new Error("expected a scheduling route handler");
  }
  const handler = route.handler as unknown as SeamHarness["handler"];
  return {
    handler,
    runtime: runtimeWithService,
    store,
    service,
    logRows: (taskId) =>
      logStore.list({ agentId: AGENT_ID, taskId, excludeRollups: true }),
    stop: async () => {
      await service.stop();
      const idx = startedServices.indexOf(service);
      if (idx >= 0) startedServices.splice(idx, 1);
    },
  };
}

const BASE_INPUT = JSON.stringify({
  kind: "reminder",
  promptInstructions: "seam test reminder",
  trigger: { kind: "manual" },
  priority: "low",
  respectsGlobalPause: true,
  source: "user_chat",
  createdBy: "seam-test",
  ownerVisible: true,
});

interface SeededTask {
  seam: SeamHarness;
  taskId: string;
}

async function seedTask(): Promise<SeededTask> {
  const seam = await makeSeam();
  const res = responseRecorder();
  await seam.handler(
    jsonRequest("POST", "/api/lifeops/scheduled-tasks", BASE_INPUT, {
      "content-length": String(BASE_INPUT.length),
    }),
    res,
    seam.runtime,
  );
  if (res.statusCode !== 201) {
    throw new Error(`seed schedule failed: ${res.statusCode} ${res.body}`);
  }
  return {
    seam,
    taskId: (JSON.parse(res.body).task as { taskId: string }).taskId,
  };
}

describe("scheduled-tasks REST seam (real reader, real service, real routes)", () => {
  afterEach(async () => {
    // Every makeSeam registers its service; stop them all so no runner leaks.
    while (startedServices.length > 0) {
      const service = startedServices.pop();
      await service?.stop();
    }
  });

  it("schedules a task through the real reader", async () => {
    const { seam, taskId } = await seedTask();
    expect(taskId).toBeTruthy();
    // The seeded row is addressable through the same seam (list).
    const res = responseRecorder();
    await seam.handler(
      jsonRequest("GET", "/api/lifeops/scheduled-tasks"),
      res,
      seam.runtime,
    );
    expect(res.statusCode).toBe(200);
    const listed = (JSON.parse(res.body) as { tasks: { taskId: string }[] })
      .tasks;
    expect(listed.some((t) => t.taskId === taskId)).toBe(true);
  });

  it("rejects an explicit {} edit body with 400 and writes no edited log row (#23977)", async () => {
    const { seam, taskId } = await seedTask();
    const res = responseRecorder();
    await seam.handler(
      jsonRequest("POST", `/api/lifeops/scheduled-tasks/${taskId}/edit`, "{}", {
        "content-length": "2",
      }),
      res,
      seam.runtime,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("at least one field");
    const edited = (await seam.logRows(taskId)).filter(
      (row) => row.transition === "edited",
    );
    expect(edited).toEqual([]);
  });

  it("applies a real edit and records exactly one edited row with the edited keys", async () => {
    const { seam, taskId } = await seedTask();
    const res = responseRecorder();
    await seam.handler(
      jsonRequest(
        "POST",
        `/api/lifeops/scheduled-tasks/${taskId}/edit`,
        '{"priority":"high"}',
        { "content-length": "19" },
      ),
      res,
      seam.runtime,
    );
    expect(res.statusCode).toBe(200);
    const edited = (await seam.logRows(taskId)).filter(
      (row) => row.transition === "edited",
    );
    expect(edited).toHaveLength(1);
    const first = edited[0];
    expect(first).toBeDefined();
    expect((first.detail as { keys?: string[] }).keys).toEqual(["priority"]);
  });

  it("reads a chunked edit body without content-length (#23930 through the seam)", async () => {
    const { seam, taskId } = await seedTask();
    const res = responseRecorder();
    await seam.handler(
      jsonRequest(
        "POST",
        `/api/lifeops/scheduled-tasks/${taskId}/edit`,
        '{"promptInstructions":"chunked edit"}',
        { "transfer-encoding": "chunked" },
      ),
      res,
      seam.runtime,
    );
    expect(res.statusCode).toBe(200);
    const edited = (await seam.logRows(taskId)).filter(
      (row) => row.transition === "edited",
    );
    expect(edited).toHaveLength(1);
  });

  it("rejects an empty chunked edit body with the reader's 400 parse error", async () => {
    const { seam, taskId } = await seedTask();
    const res = responseRecorder();
    await seam.handler(
      jsonRequest(
        "POST",
        `/api/lifeops/scheduled-tasks/${taskId}/edit`,
        undefined,
        { "transfer-encoding": "chunked" },
      ),
      res,
      seam.runtime,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("Invalid JSON");
    const edited = (await seam.logRows(taskId)).filter(
      (row) => row.transition === "edited",
    );
    expect(edited).toEqual([]);
  });

  it("rejects malformed JSON with the reader's 400", async () => {
    const { seam, taskId } = await seedTask();
    const res = responseRecorder();
    const body = "{oops";
    await seam.handler(
      jsonRequest("POST", `/api/lifeops/scheduled-tasks/${taskId}/edit`, body, {
        "content-length": String(body.length),
      }),
      res,
      seam.runtime,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("Invalid JSON");
  });

  it("rejects a JSON null body with the reader's non-object 400", async () => {
    const { seam, taskId } = await seedTask();
    const res = responseRecorder();
    await seam.handler(
      jsonRequest(
        "POST",
        `/api/lifeops/scheduled-tasks/${taskId}/edit`,
        "null",
        { "content-length": "4" },
      ),
      res,
      seam.runtime,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("must be a JSON object");
    const edited = (await seam.logRows(taskId)).filter(
      (row) => row.transition === "edited",
    );
    expect(edited).toEqual([]);
  });

  it("rejects an over-1MiB edit body with the reader's 413", async () => {
    const { seam, taskId } = await seedTask();
    const res = responseRecorder();
    const body = `{"pad":"${"x".repeat(1_100_000)}"}`;
    await seam.handler(
      jsonRequest("POST", `/api/lifeops/scheduled-tasks/${taskId}/edit`, body, {
        "content-length": String(body.length),
      }),
      res,
      seam.runtime,
    );
    expect(res.statusCode).toBe(413);
    const edited = (await seam.logRows(taskId)).filter(
      (row) => row.transition === "edited",
    );
    expect(edited).toEqual([]);
  });

  it("honors a chunked test-probe body without content-length (#23977)", async () => {
    const seam = await makeSeam();
    const res = responseRecorder();
    await seam.handler(
      jsonRequest(
        "POST",
        "/api/lifeops/scheduled-tasks/test-probe",
        '{"kind":"checkin"}',
        { "transfer-encoding": "chunked" },
      ),
      res,
      seam.runtime,
    );
    expect(res.statusCode).toBe(201);
    const payload = JSON.parse(res.body) as {
      task: {
        kind: string;
        taskId: string;
        metadata?: Record<string, unknown>;
      };
      fire: { kind: string };
    };
    expect(payload.task.kind).toBe("checkin");
    expect(payload.fire.kind).toBe("fired");
    // The injected dispatcher is void (TestNoop): the runner records a fire
    // without a typed dispatch result, so no lastDispatchResult may appear.
    const rows = await seam.logRows(payload.task.taskId);
    expect(rows.length).toBeGreaterThan(0);
    const storeTask = payload.task;
    expect(
      (storeTask.metadata as { lastDispatchResult?: unknown })
        ?.lastDispatchResult,
    ).toBeUndefined();
  });

  it("defaults the test-probe to a reminder when no body framing is present", async () => {
    const seam = await makeSeam();
    const res = responseRecorder();
    await seam.handler(
      jsonRequest("POST", "/api/lifeops/scheduled-tasks/test-probe"),
      res,
      seam.runtime,
    );
    expect(res.statusCode).toBe(201);
    const payload = JSON.parse(res.body) as { task: { kind: string } };
    expect(payload.task.kind).toBe("reminder");
  });

  async function scheduleCron(
    seam: SeamHarness,
    expression: string,
    tz: string,
  ): Promise<RecordedResponse> {
    const body = JSON.stringify({
      ...JSON.parse(BASE_INPUT),
      trigger: { kind: "cron", expression, tz },
    });
    const res = responseRecorder();
    await seam.handler(
      jsonRequest("POST", "/api/lifeops/scheduled-tasks", body, {
        "content-length": String(Buffer.byteLength(body)),
      }),
      res,
      seam.runtime,
    );
    return res;
  }

  it("rejects a cron trigger zone the scheduler cannot resolve with 400", async () => {
    // Core's cron scheduler evaluates an unresolvable zone on UTC, so a
    // "9am Pacific" task would fire at 09:00 UTC.
    const seam = await makeSeam();
    for (const tz of ["Pacific Time", "America/LosAngeles"]) {
      const res = await scheduleCron(seam, "0 9 * * *", tz);
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain(
        "task.trigger.tz must be a valid IANA time zone",
      );
    }
  });

  it("rejects an unparseable cron expression with 400", async () => {
    // Core returns no next run for it, so the task would never fire.
    const seam = await makeSeam();
    const res = await scheduleCron(seam, "every day", "UTC");
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain(
      "task.trigger.expression must be a valid 5-field cron expression",
    );
  });

  it("rejects a cron expression whose date never occurs with 400", async () => {
    // Parseable, but February has no day 30 and April no day 31: core finds
    // no next run, so the task would never fire.
    const seam = await makeSeam();
    for (const expression of ["0 0 30 2 *", "0 0 31 4,6 *", "0 0 31 2 */2"]) {
      const res = await scheduleCron(seam, expression, "UTC");
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain(
        "task.trigger.expression names a date that never occurs",
      );
    }
  });

  it("accepts a cron expression for a leap day or an either-day schedule", async () => {
    // Feb 29 exists in a leap year. With both day fields restricted core fires
    // on either one, so `30 2 1` still runs on February Mondays.
    const seam = await makeSeam();
    // A step month (`*/2`) still includes January, and one listed month with
    // the day is enough (`30 2,4` runs on April 30).
    for (const expression of [
      "0 0 29 2 *",
      "0 0 30 2 1",
      "0 0 31 2 7",
      "0 0 31 * *",
      "0 0 31 */2 *",
      "0 0 30 2,4 *",
    ]) {
      const res = await scheduleCron(seam, expression, "UTC");
      expect(res.statusCode).toBe(201);
    }
  });

  it("rejects an edit to an unresolvable cron trigger zone with 400", async () => {
    const { seam, taskId } = await seedTask();
    const body = JSON.stringify({
      trigger: { kind: "cron", expression: "0 9 * * *", tz: "Pacific Time" },
    });
    const res = responseRecorder();
    await seam.handler(
      jsonRequest("POST", `/api/lifeops/scheduled-tasks/${taskId}/edit`, body, {
        "content-length": String(Buffer.byteLength(body)),
      }),
      res,
      seam.runtime,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain(
      "task.trigger.tz must be a valid IANA time zone",
    );
  });

  it("keeps a stored cron task with an unresolvable zone editable and importable", async () => {
    // A row stored before the trigger checks existed keeps firing; pausing it
    // or moving it in a cutover must not fail on its stored trigger.
    const { seam, taskId } = await seedTask();
    const seeded = await seam.store.get(taskId);
    if (!seeded) throw new Error("seeded task missing");
    const stored: ScheduledTask = {
      ...seeded,
      trigger: { kind: "cron", expression: "every day", tz: "Pacific Time" },
    };
    await seam.store.upsert(stored);

    const body = JSON.stringify({ priority: "high" });
    const res = responseRecorder();
    await seam.handler(
      jsonRequest("POST", `/api/lifeops/scheduled-tasks/${taskId}/edit`, body, {
        "content-length": String(Buffer.byteLength(body)),
      }),
      res,
      seam.runtime,
    );
    expect(res.statusCode).toBe(200);
    expect((await seam.store.get(taskId))?.priority).toBe("high");

    const imported = await seam.service
      .getRunner({ agentId: AGENT_ID })
      .importTask(
        { ...stored, taskId: "stored-cron-import" },
        { sourceAgentId: "shared-agent", cutoverToken: "cutover-1" },
      );
    expect(imported.imported).toBe(true);
    expect(imported.task.trigger).toEqual(stored.trigger);
  });

  it("accepts a cron trigger with an IANA zone or owner_local", async () => {
    const seam = await makeSeam();
    for (const tz of ["America/Los_Angeles", "owner_local"]) {
      const res = await scheduleCron(seam, "0 9 * * *", tz);
      expect(res.statusCode).toBe(201);
    }
  });
});
