/**
 * The scheduled-tasks route builds its request URL from the Host and
 * X-Forwarded-Proto headers. Proxies append a hop to X-Forwarded-Proto
 * ("https, http"), and Node joins repeated header lines the same way, so the
 * route must read the first value as the host route layer does. The requests
 * here go over real HTTP to the production route handler on an initialized
 * runtime with the scheduled-task runner service registered.
 *
 * ELIZA_FORWARDED_PROTO_MODEL_CASES replays the request sequences generated
 * from quint/ForwardedProtoRouteBase.qnt (see check-forwarded-proto.mjs).
 */
import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentRuntime, IAgentRuntime } from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createInMemoryScheduledTaskStore,
  TestNoopScheduledTaskDispatcher,
} from "../scheduled-task/runner.js";
import {
  registerScheduledTaskRunnerDeps,
  ScheduledTaskRunnerService,
} from "../scheduled-task/runner-service.js";
import { createInMemoryScheduledTaskLogStore } from "../scheduled-task/state-log.js";
import { buildSchedulingRoutes } from "./plugin-routes.js";

// Raw header lines in Node's rawHeaders form, so a repeated line stays two
// lines on the wire. The indices match `header` in the Quint model.
const FORWARDED_PROTO_LINES: readonly (readonly string[])[] = [
  [],
  ["X-Forwarded-Proto", "https"],
  ["X-Forwarded-Proto", "https, http"],
  ["X-Forwarded-Proto", "https", "X-Forwarded-Proto", "http"],
  ["X-Forwarded-Proto", ""],
];
const HEADER_NAMES = [
  "no X-Forwarded-Proto",
  "one hop",
  "two hops on one line",
  "two header lines",
  "an empty value",
];
const SCHEDULED_TASKS_ROUTE = 0;

interface ModelCase {
  route: number;
  headers: number[];
}
const casesFile = process.env.ELIZA_FORWARDED_PROTO_MODEL_CASES;
const modelCases: ModelCase[] = casesFile
  ? (JSON.parse(readFileSync(casesFile, "utf8")) as ModelCase[]).filter(
      (item) => item.route === SCHEDULED_TASKS_ROUTE,
    )
  : FORWARDED_PROTO_LINES.map((_, header) => ({
      route: SCHEDULED_TASKS_ROUTE,
      headers: [header],
    }));

let runtime: AgentRuntime;
let server: http.Server;
let port: number;

beforeAll(async () => {
  runtime = createSQLiteTestRuntime({
    character: { name: "scheduled-tasks-forwarded-proto" },
  });
  await runtime.initialize({ skipMigrations: true });
  registerScheduledTaskRunnerDeps(runtime, () => ({
    store: createInMemoryScheduledTaskStore(),
    logStore: createInMemoryScheduledTaskLogStore(),
    dispatcher: TestNoopScheduledTaskDispatcher,
    ownerFacts: () => ({}),
    globalPause: { current: async () => ({ active: false }) },
    activity: { hasSignalSince: () => false },
    subjectStore: { wasUpdatedSince: () => false },
  }));
  await runtime.registerService(ScheduledTaskRunnerService);
  await runtime.getServiceLoadPromise(ScheduledTaskRunnerService.serviceType);
  const [route] = buildSchedulingRoutes();
  const handler = route?.handler as unknown as (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    runtime: IAgentRuntime,
  ) => Promise<void>;
  // Same failure mapping as the host's runtime plugin route dispatcher.
  server = http.createServer((req, res) => {
    handler(req, res, runtime).catch((error: unknown) => {
      if (res.headersSent) return;
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  port = (server.address() as AddressInfo).port;
}, 120_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await runtime?.stop();
  await runtime?.close();
});

function listScheduledTasks(header: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      method: "GET",
      path: "/api/lifeops/scheduled-tasks",
      headers: [
        "Host",
        "agent.example.com",
        ...(FORWARDED_PROTO_LINES[header] ?? []),
      ],
    });
    req.on("response", (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        body += chunk;
      });
      res.on("end", () => resolve(`${res.statusCode} ${body}`));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("scheduled-tasks route behind proxies", () => {
  it.each(
    FORWARDED_PROTO_LINES.map((_, header) => [HEADER_NAMES[header], header]),
  )("serves the task list with %s", async (_name, header) => {
    const direct = await listScheduledTasks(0);
    expect(direct).toBe('200 {"tasks":[]}');
    expect(await listScheduledTasks(header as number)).toBe(direct);
  });

  it("replays the forwarded proto model through the scheduled-task route", async () => {
    expect(modelCases.length).toBeGreaterThan(0);
    const direct = await listScheduledTasks(0);
    for (const item of modelCases) {
      for (const header of item.headers) {
        expect(await listScheduledTasks(header), HEADER_NAMES[header]).toBe(
          direct,
        );
      }
    }
  });
});
