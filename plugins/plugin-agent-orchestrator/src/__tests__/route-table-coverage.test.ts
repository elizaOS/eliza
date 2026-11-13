/**
 * Every path a handler in `src/api/*.ts` serves must have a registered template:
 * the host matches templates segment by segment before the shared dispatcher
 * runs, so an unregistered handler answers 404 at the server.
 *
 * Deliberately unregistered (dead or owned elsewhere): `auth/:agent` and
 * `:id/scratch/(keep|delete|promote)`.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { IAgentRuntime } from "@elizaos/core";
import type { Route } from "@elizaos/host/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CODING_AGENT_ROUTE_PATHS,
  codingAgentRoutePlugin,
} from "../setup-routes.js";

/** One sample request per handler branch, grouped by route module. */
const HANDLER_SAMPLES: Array<[string, string]> = [
  // orchestrator-routes.ts
  ["GET", "/api/orchestrator/status"],
  ["GET", "/api/orchestrator/capacity"],
  ["GET", "/api/orchestrator/accounts"],
  ["GET", "/api/orchestrator/accounts/readiness"],
  ["GET", "/api/orchestrator/rooms"],
  ["GET", "/api/orchestrator/widgets"],
  ["GET", "/api/orchestrator/widgets/stream"],
  ["GET", "/api/orchestrator/built-apps"],
  ["DELETE", "/api/orchestrator/built-apps/web/my-app"],
  ["POST", "/api/orchestrator/pause-all"],
  ["POST", "/api/orchestrator/resume-all"],
  ["GET", "/api/orchestrator/tasks"],
  ["POST", "/api/orchestrator/tasks"],
  ["GET", "/api/orchestrator/tasks/t1"],
  ["PATCH", "/api/orchestrator/tasks/t1"],
  ["DELETE", "/api/orchestrator/tasks/t1"],
  ...[
    "pause",
    "resume",
    "archive",
    "reopen",
    "fork",
    "validate",
    "auto-validate",
    "retry-turn",
    "rerun-from-event",
    "restart",
    "restart-with-edited-plan",
    "plan-revisions",
    "messages",
    "agents",
  ].map((sub): [string, string] => [
    "POST",
    `/api/orchestrator/tasks/t1/${sub}`,
  ]),
  ...[
    "stream",
    "plan-revisions",
    "messages",
    "timeline",
    "events",
    "usage",
    "trace-usage",
  ].map((sub): [string, string] => [
    "GET",
    `/api/orchestrator/tasks/t1/${sub}`,
  ]),
  ["POST", "/api/orchestrator/tasks/t1/agents/s1/stop"],
  // parent-context-routes.ts
  ["GET", "/api/coding-agents/s1/parent-context"],
  ["GET", "/api/coding-agents/s1/memory"],
  ["GET", "/api/coding-agents/s1/active-workspaces"],
  ["GET", "/api/coding-agents/s1/skills"],
  ["GET", "/api/coding-agents/s1/skills/lint"],
  // bridge-routes.ts
  ["POST", "/api/coding-agents/s1/credentials/request"],
  ["GET", "/api/coding-agents/s1/credentials/OPENAI_API_KEY"],
  // agent-routes.ts
  ["GET", "/api/coding-agents/preflight"],
  ["GET", "/api/coding-agents/metrics"],
  ["GET", "/api/coding-agents/workspace-files"],
  ["GET", "/api/coding-agents/approval-presets"],
  ["GET", "/api/coding-agents/settings"],
  ["POST", "/api/coding-agents/settings"],
  ["GET", "/api/coding-agents/approval-config"],
  ["POST", "/api/coding-agents/approval-config"],
  ["GET", "/api/coding-agents"],
  ["POST", "/api/coding-agents/spawn"],
  ["GET", "/api/coding-agents/s1"],
  ["POST", "/api/coding-agents/s1/send"],
  ["POST", "/api/coding-agents/s1/stop"],
  ["GET", "/api/coding-agents/s1/output"],
  ["GET", "/api/coding-agents/s1/buffered-output"],
  // workspace-routes.ts
  ["POST", "/api/workspace/provision"],
  ["GET", "/api/workspace/w1"],
  ["DELETE", "/api/workspace/w1"],
  ["POST", "/api/workspace/w1/commit"],
  ["POST", "/api/workspace/w1/push"],
  ["POST", "/api/workspace/w1/pr"],
  // issue-routes.ts
  ["GET", "/api/issues"],
  ["POST", "/api/issues"],
  ["GET", "/api/issues/acme/app/7"],
  ["POST", "/api/issues/acme/app/7/comments"],
  ["POST", "/api/issues/acme/app/7/close"],
];

function matches(pattern: string, pathname: string): boolean {
  const p = pattern.split("/").filter(Boolean);
  const c = pathname.split("/").filter(Boolean);
  return (
    p.length === c.length &&
    p.every((seg, i) => seg.startsWith(":") || seg === c[i])
  );
}

describe("coding-agent route table coverage", () => {
  it.each(HANDLER_SAMPLES)(
    "%s %s has a registered template",
    (method, path) => {
      expect(
        CODING_AGENT_ROUTE_PATHS.some(
          (route) => route.type === method && matches(route.path, path),
        ),
      ).toBe(true);
    },
  );

  describe("issue comment POST", () => {
    let server: Server;
    let baseUrl: string;
    const runtime = {
      getService: () => null,
      hasService: () => false,
    } as unknown as IAgentRuntime;

    beforeAll(async () => {
      server = createServer((req, res) => {
        const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
        const route = (codingAgentRoutePlugin.routes as Route[]).find(
          (r) => r.type === req.method && matches(r.path, pathname),
        );
        if (!route?.handler) {
          res.writeHead(404).end();
          return;
        }
        void route.handler(req as never, res as never, runtime as never);
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it("reaches the comment handler", async () => {
      const response = await fetch(
        `${baseUrl}/api/issues/acme/app/7/comments`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ body: "hello" }),
        },
      );
      // No workspace service in this runtime: the comment handler itself
      // answers 503, where an unmatched path would get the dispatcher's 404.
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        error: "Workspace Service not available",
      });
    });
  });
});
