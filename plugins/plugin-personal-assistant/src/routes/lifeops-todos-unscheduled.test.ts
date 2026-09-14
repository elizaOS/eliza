/**
 * Exercises the todo HTTP projection against real LifeOps services and PGlite.
 * Persisted undated status and caller ownership must survive route serialization.
 */
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import type { AgentRuntime, UUID } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { createLifeOpsTestRuntime } from "../../test/helpers/runtime.js";
import { LifeOpsService } from "../lifeops/service.js";
import {
  handleLifeOpsRoutes,
  type LifeOpsRouteContext,
} from "./lifeops-routes.js";

interface CapturedResponse {
  statusCode?: number;
  body?: string;
  ended: boolean;
}

function buildCtx(
  runtime: AgentRuntime,
  owner: string,
  search = "",
): {
  ctx: LifeOpsRouteContext;
  res: CapturedResponse;
} {
  const res: CapturedResponse = { ended: false };
  const socket = new Socket();
  Object.defineProperty(socket, "remoteAddress", {
    value: "127.0.0.1",
    configurable: true,
  });
  const httpReq = new IncomingMessage(socket);
  httpReq.method = "GET";
  const httpRes = new ServerResponse(httpReq);
  httpRes.statusCode = 0;
  httpRes.end = function end(
    this: ServerResponse,
    chunk?: unknown,
    encodingOrCallback?: BufferEncoding | (() => void),
    callback?: () => void,
  ): ServerResponse {
    res.ended = true;
    res.body = typeof chunk === "string" ? chunk : "";
    res.statusCode = this.statusCode;
    const done =
      typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    done?.();
    return this;
  };

  const ctx: LifeOpsRouteContext = {
    req: httpReq,
    res: httpRes,
    method: "GET",
    pathname: "/api/lifeops/todos",
    url: new URL(`http://localhost/api/lifeops/todos${search}`),
    state: {
      runtime,
      adminEntityId: owner,
    },
    json(r, data, status = 200) {
      r.statusCode = status;
      r.setHeader?.("content-type", "application/json");
      r.end?.(JSON.stringify(data));
    },
    error(r, message, status = 400) {
      r.statusCode = status;
      r.setHeader?.("content-type", "application/json");
      r.end?.(JSON.stringify({ error: message }));
    },
    async readJsonBody<T extends object>(): Promise<T | null> {
      return null;
    },
    decodePathComponent(raw) {
      try {
        return decodeURIComponent(raw);
      } catch {
        return null;
      }
    },
  };
  return { ctx, res };
}

describe("GET /api/lifeops/todos persisted owner records", () => {
  it("serializes the durable todo status without manufacturing an occurrence", async () => {
    const host = await createLifeOpsTestRuntime();
    const owner = crypto.randomUUID() as UUID;
    try {
      const service = new LifeOpsService(host.runtime, {
        ownerEntityId: owner,
      });
      const created = await service.createDefinition({
        title: "Read the complete draft",
        kind: "task",
        cadence: { kind: "unscheduled" },
        timezone: "UTC",
      });
      const id = created.definition.id;
      const pending = buildCtx(host.runtime, owner);
      await handleLifeOpsRoutes(pending.ctx);
      expect(pending.res.statusCode).toBe(200);
      expect(JSON.parse(pending.res.body ?? "invalid").todos).toEqual([
        expect.objectContaining({
          id,
          targetKind: "definition",
          title: "Read the complete draft",
          status: "pending",
          dueDate: null,
        }),
      ]);
      await service.completeTodo(id);
      const completed = buildCtx(host.runtime, owner);
      await handleLifeOpsRoutes(completed.ctx);
      expect(JSON.parse(completed.res.body ?? "invalid").todos).toEqual([
        expect.objectContaining({
          id,
          targetKind: "definition",
          status: "completed",
          dueDate: null,
        }),
      ]);
      expect(
        await service.repository.listOccurrencesForDefinition(
          host.runtime.agentId,
          id,
        ),
      ).toEqual([]);
    } finally {
      await host.cleanup();
    }
  });

  it("does not expose another owner's persisted todo through the route", async () => {
    const host = await createLifeOpsTestRuntime();
    const owner = crypto.randomUUID() as UUID;
    const other = crypto.randomUUID() as UUID;
    try {
      const ownService = new LifeOpsService(host.runtime, {
        ownerEntityId: owner,
      });
      const otherService = new LifeOpsService(host.runtime, {
        ownerEntityId: other,
      });
      const own = await ownService.createDefinition({
        title: "Visible owner record",
        kind: "task",
        cadence: { kind: "unscheduled" },
        timezone: "UTC",
      });
      await otherService.createDefinition({
        title: "Other owner private record",
        kind: "task",
        cadence: { kind: "unscheduled" },
        timezone: "UTC",
      });
      const request = buildCtx(host.runtime, owner);
      await handleLifeOpsRoutes(request.ctx);
      expect(request.res.statusCode).toBe(200);
      expect(JSON.parse(request.res.body ?? "invalid").todos).toEqual([
        expect.objectContaining({
          id: own.definition.id,
          title: "Visible owner record",
        }),
      ]);
    } finally {
      await host.cleanup();
    }
  });
});
