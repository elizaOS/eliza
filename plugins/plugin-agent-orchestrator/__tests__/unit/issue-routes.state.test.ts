/**
 * Exercises issue-list state validation through the raw Node HTTP handler with
 * a deterministic workspace service.
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

function routeContext(): RouteContext {
  return {
    runtime: {},
    acpService: null,
    workspaceService: { listIssues },
  } as never;
}

function request(url: string): IncomingMessage {
  return Object.assign(Readable.from([]), {
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
    if (chunk !== undefined) {
      this.body = chunk;
    }
    return this;
  }
}

async function list(query: string) {
  const res = new CapturingResponse();
  const handled = await handleIssueRoutes(
    request(`/api/issues?repo=acme/widgets${query}`),
    res as unknown as ServerResponse,
    "/api/issues",
    routeContext(),
  );
  expect(handled).toBe(true);
  return {
    status: res.statusCode,
    body: JSON.parse(res.body) as unknown,
  };
}

describe("GET /api/issues state", () => {
  beforeEach(() => {
    listIssues.mockClear();
  });

  it.each([
    ["", "open"],
    ["&state=", "open"],
    ["&state=open", "open"],
    ["&state=closed", "closed"],
    ["&state=all", "all"],
  ])("maps %s to %s", async (query, state) => {
    const response = await list(query);

    expect(response.status).toBe(200);
    expect(listIssues).toHaveBeenCalledWith("acme/widgets", {
      state,
      labels: undefined,
    });
  });

  it("preserves label parsing", async () => {
    const response = await list("&state=open&labels=bug,help%20wanted");

    expect(response.status).toBe(200);
    expect(listIssues).toHaveBeenCalledWith("acme/widgets", {
      state: "open",
      labels: ["bug", "help wanted"],
    });
  });

  it.each(["OPEN", "CLOSED", "1", "true", "foo", "1e2"])(
    "rejects unsupported state %s before listing issues",
    async (state) => {
      const response = await list(`&state=${encodeURIComponent(state)}`);

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error: "state must be one of: open, closed, all",
      });
      expect(listIssues).not.toHaveBeenCalled();
    },
  );
});
