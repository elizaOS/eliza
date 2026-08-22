/**
 * Runs Taskmarket discovery through the real deterministic agent loop.
 *
 * The production action and HTTP client are registered with an injected fetch
 * transport so the scenario exercises routing, filter serialization, response
 * validation, reward formatting, and the read-only result contract without
 * credentials or live network access.
 */

import type { AgentRuntime } from "@elizaos/core";
import {
  describeCalls,
  successfulActionData,
  toRecord,
} from "@elizaos/scenario-runner/scenario-assertions";
import { scenario } from "@elizaos/scenario-runner/schema";
import { createBrowseTaskmarketTasksAction } from "../../src/actions/browse-tasks.js";
import { TaskmarketClient } from "../../src/client.js";

const ACTION = "BROWSE_TASKMARKET_TASKS";
const INPUT =
  "Browse open Taskmarket bounties above 1 USDC that expire within 24 hours.";
const BASE_URL = "https://taskmarket.scenario.test";

const taskFixture = {
  id: "task-42",
  description: "Implement a deterministic Taskmarket integration test",
  reward: "4500000",
  netReward: "4162500",
  status: "open",
  mode: "bounty",
  expiryTime: "2026-08-12T00:00:00.000Z",
  tags: ["integration", "testing"],
  submissionCount: 2,
};

interface ObservedRequest {
  url: string;
  method: string;
  body: BodyInit | null | undefined;
}

let observedRequests: ObservedRequest[] = [];

const taskmarketFetch: typeof fetch = async (input, init) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof Request
        ? input.url
        : input.toString();
  observedRequests.push({
    url,
    method: (init?.method ?? "GET").toUpperCase(),
    body: init?.body,
  });
  return new Response(
    JSON.stringify({ tasks: [taskFixture], hasMore: false, nextCursor: null }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
};

type ScenarioRuntime = AgentRuntime;

export default scenario({
  lane: "pr-deterministic",
  modelFixtures: {
    mode: "fixtures",
    fixtures: [],
  },
  id: "taskmarket.browse-open-tasks",
  title: "Taskmarket: browse open bounties through the read-only action",
  domain: "taskmarket",
  tags: ["smoke", "taskmarket", "read-only"],
  description:
    "Routes public Taskmarket discovery through the production action and HTTP parser with a deterministic transport.",

  requires: { plugins: ["@elizaos/plugin-taskmarket"] },
  isolation: "per-scenario",

  seed: [
    {
      type: "custom",
      name: "register-taskmarket-http-fixture",
      apply: async (ctx) => {
        observedRequests = [];
        const runtime = ctx.runtime as ScenarioRuntime;
        const action = createBrowseTaskmarketTasksAction(
          () => new TaskmarketClient(BASE_URL, taskmarketFetch),
        );
        runtime.registerAction({ ...action, override: true });
        return undefined;
      },
    },
  ],

  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Taskmarket discovery",
    },
  ],

  turns: [
    {
      kind: "action",
      name: "browse-open-bounties",
      actionName: ACTION,
      options: {
        parameters: {
          limit: 3,
          mode: "bounty",
          sort: "deadline_asc",
          minRewardBaseUnits: "1000000",
          deadlineHours: 24,
        },
      },
      text: INPUT,
      timeoutMs: 120_000,
      assertTurn: (turn) => {
        const call = turn.actionsCalled.find(
          (candidate) => candidate.actionName === ACTION,
        );
        if (!call) {
          return `Expected ${ACTION} but got: ${turn.actionsCalled
            .map((candidate) => candidate.actionName)
            .join(", ")}`;
        }
        if (!call.result?.success) {
          return `${ACTION} did not succeed: ${
            call.error?.message ?? call.result?.text ?? "unknown error"
          }`;
        }
      },
    },
  ],

  finalChecks: [
    {
      type: "actionCalled",
      actionName: ACTION,
      status: "success",
      minCount: 1,
    },
    {
      type: "custom",
      name: "taskmarket-read-only-discovery-effect",
      predicate: (ctx) => {
        const data = successfulActionData(ctx, ACTION);
        if (!data) {
          return `no successful ${ACTION} result data; calls: ${describeCalls(ctx)}`;
        }
        if (data.readOnly !== true) {
          return `expected readOnly=true, saw ${JSON.stringify(data).slice(0, 300)}`;
        }
        const tasks = Array.isArray(data.tasks) ? data.tasks : [];
        const task = toRecord(tasks[0]);
        if (
          tasks.length !== 1 ||
          task?.id !== taskFixture.id ||
          task.netRewardUsdc !== "4.1625" ||
          task.status !== "open" ||
          task.mode !== "bounty"
        ) {
          return `unexpected parsed task page: ${JSON.stringify(data).slice(0, 500)}`;
        }

        if (observedRequests.length !== 1) {
          return `expected one Taskmarket request, saw ${observedRequests.length}`;
        }
        const [request] = observedRequests;
        if (!request) return "Taskmarket request was not recorded";
        const url = new URL(request.url);
        const expectedFilters: Record<string, string> = {
          status: "open",
          sort: "deadline_asc",
          limit: "3",
          mode: "bounty",
          minReward: "1000000",
          deadlineHours: "24",
        };
        for (const [key, expected] of Object.entries(expectedFilters)) {
          if (url.searchParams.get(key) !== expected) {
            return `expected ${key}=${expected}, saw ${url.searchParams.get(key)}`;
          }
        }
        if (request.method !== "GET" || request.body != null) {
          return `discovery must remain a bodyless GET; saw ${request.method}`;
        }
      },
    },
  ],
});
