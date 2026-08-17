/**
 * GET /api/issues `state` is list-filter identity, leftover tax after
 * orchestrator includeArchived (#21265). Stock develop cast any token
 * through to listIssues, so `state=OPEN` / `foo` / `1` kept an unknown
 * catalog value instead of a 400. labels / repo stay untouched.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/core/client-public", () => ({
  resolveAliasedEnvValue: (key: string) => process.env[key],
  isTruthyEnvValue: () => false,
  isElizaSettingsDebugEnabled: () => false,
  sanitizeForSettingsDebug: (value: unknown) => value,
  settingsDebugCloudSummary: () => ({}),
  sanitizeSpeechText: (value: string) => value,
  formatError: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
}));

import { handleIssueRoutes } from "../../src/api/issue-routes.js";
import type { RouteContext } from "../../src/api/route-utils.js";

const listIssues = vi.fn(async () => [{ number: 1, title: "one" }]);

function ctxWithList(): RouteContext {
  return {
    runtime: {},
    acpService: null,
    workspaceService: { listIssues },
  } as never;
}

function makeReq(url: string): IncomingMessage {
  const stream = Readable.from([]);
  return Object.assign(stream, {
    method: "GET",
    url,
    headers: { host: "localhost" },
  }) as unknown as IncomingMessage;
}

class CapturingResponse {
  statusCode = 0;
  body = "";
  writeHead(status: number): this {
    this.statusCode = status;
    return this;
  }
  end(chunk?: string): this {
    if (chunk !== undefined) this.body = chunk;
    return this;
  }
  json(): Record<string, unknown> {
    return this.body ? (JSON.parse(this.body) as Record<string, unknown>) : {};
  }
}

async function list(query: string) {
  const req = makeReq(`/api/issues?repo=acme/widgets${query}`);
  const res = new CapturingResponse();
  const matched = await handleIssueRoutes(
    req,
    res as unknown as ServerResponse,
    "/api/issues",
    ctxWithList(),
  );
  expect(matched).toBe(true);
  return { status: res.statusCode, body: res.json() };
}

describe("GET /api/issues state identity", () => {
  beforeEach(() => {
    listIssues.mockClear();
  });

  it.each(["", "&state=", "&state=open"])(
    "accepts %s as the open-issue list",
    async (query) => {
      const result = await list(query);
      expect(result.status).toBe(200);
      expect(listIssues).toHaveBeenCalledTimes(1);
      expect(listIssues).toHaveBeenCalledWith("acme/widgets", {
        state: "open",
        labels: undefined,
      });
    },
  );

  it("accepts state=closed as the closed-issue list", async () => {
    const result = await list("&state=closed");
    expect(result.status).toBe(200);
    expect(listIssues).toHaveBeenCalledWith("acme/widgets", {
      state: "closed",
      labels: undefined,
    });
  });

  it("accepts state=all as the unfiltered list", async () => {
    const result = await list("&state=all");
    expect(result.status).toBe(200);
    expect(listIssues).toHaveBeenCalledWith("acme/widgets", {
      state: "all",
      labels: undefined,
    });
  });

  it.each(["OPEN", "CLOSED", "ALL", "1", "0", "true", "foo", "1e2"])(
    "rejects state=%s before listIssues",
    async (token) => {
      const result = await list(`&state=${encodeURIComponent(token)}`);
      expect(result.status).toBe(400);
      expect(result.body).toEqual({ error: "Invalid state" });
      expect(listIssues).not.toHaveBeenCalled();
    },
  );

  it.each([
    "&state=open&state=open",
    "&state=open&state=closed",
    "&state=&state=open",
    "&state=foo&state=open",
  ])("rejects duplicate state values in %s before listIssues", async (query) => {
    const result = await list(query);
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: "Invalid state" });
    expect(listIssues).not.toHaveBeenCalled();
  });
});
