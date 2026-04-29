import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleComputerUseCompatRoutes } from "./computer-use-compat-routes";
import type { CompatRuntimeState } from "./compat-route-shared";

interface Harness {
  baseUrl: string;
  dispose: () => Promise<void>;
}

type ApprovalSnapshot = {
  mode: "full_control" | "smart_approve" | "approve_all" | "off";
  pendingCount: number;
  pendingApprovals: Array<{
    id: string;
    command: string;
    parameters: Record<string, unknown>;
    requestedAt: string;
  }>;
};

function stateWithService(service: unknown): CompatRuntimeState {
  return {
    current: {
      getService(name: string): unknown {
        return name === "computeruse" ? service : null;
      },
    } as CompatRuntimeState["current"],
    pendingAgentName: null,
    pendingRestartReasons: [],
  };
}

function emptyState(): CompatRuntimeState {
  return {
    current: null,
    pendingAgentName: null,
    pendingRestartReasons: [],
  };
}

async function startApiHarness(state: CompatRuntimeState): Promise<Harness> {
  const server = http.createServer(async (req, res) => {
    try {
      const handled = await handleComputerUseCompatRoutes(req, res, state);
      if (!handled && !res.headersSent) {
        res.statusCode = 404;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "not-found" }));
      }
    } catch (error) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(
          JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    dispose: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

describe("computer-use compat routes", () => {
  let originalToken: string | undefined;
  let harness: Harness | null;

  beforeEach(() => {
    originalToken = process.env.ELIZA_API_TOKEN;
    delete process.env.ELIZA_API_TOKEN;
    harness = null;
  });

  afterEach(async () => {
    await harness?.dispose();
    if (originalToken === undefined) {
      delete process.env.ELIZA_API_TOKEN;
    } else {
      process.env.ELIZA_API_TOKEN = originalToken;
    }
  });

  it("returns a truthful 404 when approval snapshot service is unavailable", async () => {
    harness = await startApiHarness(emptyState());

    const response = await fetch(
      `${harness.baseUrl}/api/computer-use/approvals`,
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Computer use service not available",
    });
  });

  it("does not open an SSE stream when approval service is unavailable", async () => {
    harness = await startApiHarness(emptyState());

    const response = await fetch(
      `${harness.baseUrl}/api/computer-use/approvals/stream`,
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toEqual({
      error: "Computer use service not available",
    });
  });

  it("returns the service snapshot and updates approval mode when service is registered", async () => {
    let mode: ApprovalSnapshot["mode"] = "full_control";
    const snapshot: ApprovalSnapshot = {
      mode,
      pendingCount: 1,
      pendingApprovals: [
        {
          id: "approval-1",
          command: "click",
          parameters: { x: 12, y: 34 },
          requestedAt: "2026-04-28T00:00:00.000Z",
        },
      ],
    };
    const service = {
      getApprovalSnapshot(): ApprovalSnapshot {
        return { ...snapshot, mode };
      },
      setApprovalMode(
        nextMode: ApprovalSnapshot["mode"],
      ): ApprovalSnapshot["mode"] {
        mode = nextMode;
        return mode;
      },
      resolveApproval() {
        return null;
      },
    };
    harness = await startApiHarness(stateWithService(service));

    const snapshotResponse = await fetch(
      `${harness.baseUrl}/api/computer-use/approvals`,
    );
    expect(snapshotResponse.status).toBe(200);
    await expect(snapshotResponse.json()).resolves.toEqual(snapshot);

    const modeResponse = await fetch(
      `${harness.baseUrl}/api/computer-use/approval-mode`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "smart_approve" }),
      },
    );
    expect(modeResponse.status).toBe(200);
    await expect(modeResponse.json()).resolves.toEqual({
      mode: "smart_approve",
    });
  });
});
