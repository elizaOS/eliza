import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CompatRuntimeState } from "./compat-route-shared";
import { handleComputerUseCompatRoutes } from "./computer-use-compat-routes";

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

type ComputerUseService = {
  getApprovalSnapshot(): ApprovalSnapshot;
  setApprovalMode(mode: ApprovalSnapshot["mode"]): ApprovalSnapshot["mode"];
  resolveApproval(
    id: string,
    approved: boolean,
    reason?: string,
  ): {
    id: string;
    command: string;
    approved: boolean;
    cancelled: boolean;
    mode: ApprovalSnapshot["mode"];
    requestedAt: string;
    resolvedAt: string;
    reason?: string;
  } | null;
};

function stateWithService(service: ComputerUseService): CompatRuntimeState {
  return {
    current: {
      getService(name: string): ComputerUseService | null {
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

  it("returns an empty snapshot when approval snapshot service is unavailable", async () => {
    harness = await startApiHarness(emptyState());

    const response = await fetch(
      `${harness.baseUrl}/api/computer-use/approvals`,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      mode: "full_control",
      pendingCount: 0,
      pendingApprovals: [],
    });
  });

  it("opens an empty SSE stream when approval service is unavailable", async () => {
    harness = await startApiHarness(emptyState());

    const response = await fetch(
      `${harness.baseUrl}/api/computer-use/approvals/stream`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body?.getReader();
    expect(reader).toBeTruthy();
    if (!reader) throw new Error("expected ReadableStreamDefaultReader");
    const first = await reader.read();
    await reader.cancel();
    const text = new TextDecoder().decode(first.value);
    expect(text).toContain('"pendingCount":0');
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

  it("rejects invalid approval modes before mutating the service", async () => {
    let mode: ApprovalSnapshot["mode"] = "full_control";
    const setApprovalModeCalls: string[] = [];
    const service: ComputerUseService = {
      getApprovalSnapshot() {
        return {
          mode,
          pendingCount: 0,
          pendingApprovals: [],
        };
      },
      setApprovalMode(nextMode) {
        setApprovalModeCalls.push(nextMode);
        mode = nextMode;
        return mode;
      },
      resolveApproval() {
        return null;
      },
    };
    harness = await startApiHarness(stateWithService(service));

    const response = await fetch(
      `${harness.baseUrl}/api/computer-use/approval-mode`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "always_allow" }),
      },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error:
        "mode must be one of full_control, smart_approve, approve_all, off",
    });
    expect(setApprovalModeCalls).toEqual([]);
  });

  it("returns not available for approval mode changes when the service is missing", async () => {
    harness = await startApiHarness(emptyState());

    const response = await fetch(
      `${harness.baseUrl}/api/computer-use/approval-mode`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "approve_all" }),
      },
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Computer use service not available",
    });
  });

  it("resolves queued approvals with approve, reject, and reason payloads", async () => {
    const resolved: Array<{
      id: string;
      approved: boolean;
      reason?: string;
    }> = [];
    const service: ComputerUseService = {
      getApprovalSnapshot() {
        return {
          mode: "smart_approve",
          pendingCount: 2,
          pendingApprovals: [
            {
              id: "approval/with slash",
              command: "click",
              parameters: { x: 12, y: 34 },
              requestedAt: "2026-04-28T00:00:00.000Z",
            },
            {
              id: "approval-2",
              command: "type",
              parameters: { text: "hello" },
              requestedAt: "2026-04-28T00:01:00.000Z",
            },
          ],
        };
      },
      setApprovalMode(mode) {
        return mode;
      },
      resolveApproval(id, approved, reason) {
        resolved.push({ id, approved, reason });
        if (id === "missing") {
          return null;
        }
        return {
          id,
          command: id === "approval-2" ? "type" : "click",
          approved,
          cancelled: !approved,
          mode: "smart_approve",
          requestedAt: "2026-04-28T00:00:00.000Z",
          resolvedAt: "2026-04-28T00:00:05.000Z",
          ...(reason ? { reason } : {}),
        };
      },
    };
    harness = await startApiHarness(stateWithService(service));

    const approveResponse = await fetch(
      `${harness.baseUrl}/api/computer-use/approvals/${encodeURIComponent("approval/with slash")}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ approved: true }),
      },
    );
    expect(approveResponse.status).toBe(200);
    await expect(approveResponse.json()).resolves.toMatchObject({
      id: "approval/with slash",
      command: "click",
      approved: true,
      cancelled: false,
    });

    const rejectResponse = await fetch(
      `${harness.baseUrl}/api/computer-use/approvals/approval-2`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          approved: false,
          reason: "Would click outside the target app",
        }),
      },
    );
    expect(rejectResponse.status).toBe(200);
    await expect(rejectResponse.json()).resolves.toMatchObject({
      id: "approval-2",
      command: "type",
      approved: false,
      cancelled: true,
      reason: "Would click outside the target app",
    });
    expect(resolved).toEqual([
      { id: "approval/with slash", approved: true, reason: undefined },
      {
        id: "approval-2",
        approved: false,
        reason: "Would click outside the target app",
      },
    ]);
  });

  it("validates approval resolution payloads and missing ids", async () => {
    const service: ComputerUseService = {
      getApprovalSnapshot() {
        return {
          mode: "approve_all",
          pendingCount: 0,
          pendingApprovals: [],
        };
      },
      setApprovalMode(mode) {
        return mode;
      },
      resolveApproval() {
        return null;
      },
    };
    harness = await startApiHarness(stateWithService(service));

    const invalidPayloadResponse = await fetch(
      `${harness.baseUrl}/api/computer-use/approvals/approval-1`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ approved: "yes" }),
      },
    );
    expect(invalidPayloadResponse.status).toBe(400);
    await expect(invalidPayloadResponse.json()).resolves.toEqual({
      error: "approved must be a boolean",
    });

    const missingResponse = await fetch(
      `${harness.baseUrl}/api/computer-use/approvals/missing`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ approved: false }),
      },
    );
    expect(missingResponse.status).toBe(404);
    await expect(missingResponse.json()).resolves.toEqual({
      error: "Approval not found",
    });
  });
});
