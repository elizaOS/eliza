import {
  getConnectorAccountManager,
  type IAgentRuntime,
  InMemoryConnectorAccountStorage,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  __resetBrowserWorkspaceStateForTests,
  resolveBrowserWorkspaceConnectorPartition,
} from "../workspace/browser-workspace.js";
import { handleBrowserWorkspaceRoutes } from "./workspace.js";
import {
  assertBrowserWorkspaceCommandConnectorAccountGate,
  assertBrowserWorkspaceConnectorAccountGate,
  BrowserWorkspaceConnectorAccountGateError,
} from "./workspace-account-gate.js";

function createRuntimeHarness() {
  const storage = new InMemoryConnectorAccountStorage();
  const runtime = {
    getService: vi.fn(() => null),
  } as IAgentRuntime;
  const manager = getConnectorAccountManager(runtime, storage);
  return { manager, runtime };
}

function createJsonCapture() {
  const res: { body?: unknown; statusCode?: number } = {};
  const json = (
    target: typeof res,
    data: unknown,
    status = 200,
  ): void => {
    target.statusCode = status;
    target.body = data;
  };
  return { json, res };
}

describe("browser workspace connector account gate", () => {
  it("allows connected owner or team-visible connector accounts", async () => {
    const { manager, runtime } = createRuntimeHarness();
    await manager.upsertAccount("gmail", {
      id: "work",
      role: "OWNER",
      status: "connected",
      accessGate: "open",
      metadata: { privacy: "owner_only" },
    });

    const result = await assertBrowserWorkspaceConnectorAccountGate({
      runtime,
      connectorProvider: "Gmail",
      connectorAccountId: "work",
      operation: "open browser workspace tab",
    });

    expect(result?.provider).toBe("gmail");
    expect(result?.expectedPartition).toBe(
      resolveBrowserWorkspaceConnectorPartition("gmail", "work"),
    );
  });

  it("requires a runtime for connector account validation", async () => {
    await expect(
      assertBrowserWorkspaceConnectorAccountGate({
        runtime: null,
        connectorProvider: "gmail",
        connectorAccountId: "work",
      }),
    ).rejects.toMatchObject({
      status: 503,
      code: "browser_workspace_connector_runtime_unavailable",
    });
  });

  it("denies missing, disabled, or non-browser roles", async () => {
    const { manager, runtime } = createRuntimeHarness();
    await manager.upsertAccount("gmail", {
      id: "disabled",
      role: "OWNER",
      status: "disabled",
      accessGate: "open",
      metadata: { privacy: "owner_only" },
    });
    await manager.upsertAccount("gmail", {
      id: "viewer",
      role: "GUEST",
      status: "connected",
      accessGate: "open",
      metadata: { privacy: "owner_only" },
    });

    await expect(
      assertBrowserWorkspaceConnectorAccountGate({
        runtime,
        connectorProvider: "gmail",
        connectorAccountId: "missing",
      }),
    ).rejects.toMatchObject({ status: 404 });

    await expect(
      assertBrowserWorkspaceConnectorAccountGate({
        runtime,
        connectorProvider: "gmail",
        connectorAccountId: "disabled",
      }),
    ).rejects.toMatchObject({ status: 403 });

    await expect(
      assertBrowserWorkspaceConnectorAccountGate({
        runtime,
        connectorProvider: "gmail",
        connectorAccountId: "viewer",
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("denies public connector accounts for browser workspace partitions", async () => {
    const { manager, runtime } = createRuntimeHarness();
    await manager.upsertAccount("slack", {
      id: "team",
      role: "TEAM",
      status: "connected",
      accessGate: "open",
      metadata: { privacy: "public" },
    });

    await expect(
      assertBrowserWorkspaceConnectorAccountGate({
        runtime,
        connectorProvider: "slack",
        connectorAccountId: "team",
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "browser_workspace_connector_account_privacy_denied",
    });
  });

  it("rejects raw or mismatched connector partitions", async () => {
    const { manager, runtime } = createRuntimeHarness();
    await manager.upsertAccount("gmail", {
      id: "work",
      role: "AGENT",
      status: "connected",
      accessGate: "open",
      metadata: { privacy: "team_visible" },
    });
    const workPartition = resolveBrowserWorkspaceConnectorPartition(
      "gmail",
      "work",
    );
    const otherPartition = resolveBrowserWorkspaceConnectorPartition(
      "gmail",
      "other",
    );

    await expect(
      assertBrowserWorkspaceConnectorAccountGate({
        runtime,
        partition: workPartition,
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: "browser_workspace_connector_account_required",
    });

    await expect(
      assertBrowserWorkspaceConnectorAccountGate({
        runtime,
        connectorProvider: "gmail",
        connectorAccountId: "work",
        partition: otherPartition,
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "browser_workspace_connector_partition_mismatch",
    });
  });

  it("validates connector accounts inside batch commands", async () => {
    const { manager, runtime } = createRuntimeHarness();
    await manager.upsertAccount("gmail", {
      id: "work",
      role: "OWNER",
      status: "connected",
      accessGate: "open",
      metadata: { privacy: "owner_only" },
    });

    await expect(
      assertBrowserWorkspaceCommandConnectorAccountGate({
        runtime,
        command: {
          subaction: "batch",
          steps: [
            {
              subaction: "open",
              connectorProvider: "gmail",
              connectorAccountId: "work",
            },
            {
              subaction: "open",
              connectorProvider: "gmail",
              connectorAccountId: "missing",
            },
          ],
        },
      }),
    ).rejects.toBeInstanceOf(BrowserWorkspaceConnectorAccountGateError);
  });

  it("routes open connector tabs with validated partitions and gate tab execution", async () => {
    await __resetBrowserWorkspaceStateForTests();
    const { manager, runtime } = createRuntimeHarness();
    await manager.upsertAccount("gmail", {
      id: "work",
      role: "OWNER",
      status: "connected",
      accessGate: "open",
      metadata: { privacy: "owner_only" },
    });

    const opened = createJsonCapture();
    await handleBrowserWorkspaceRoutes({
      req: {} as never,
      res: opened.res as never,
      method: "POST",
      pathname: "/api/browser-workspace/tabs",
      url: new URL("http://local/api/browser-workspace/tabs"),
      state: { runtime },
      readJsonBody: vi.fn(async () => ({
        connectorProvider: "gmail",
        connectorAccountId: "work",
        url: "about:blank",
      })),
      json: opened.json as never,
      error: vi.fn(),
    });

    const tab = (opened.res.body as { tab?: { id: string; partition: string } })
      .tab;
    expect(tab?.partition).toBe(
      resolveBrowserWorkspaceConnectorPartition("gmail", "work"),
    );

    const denied = createJsonCapture();
    await handleBrowserWorkspaceRoutes({
      req: {} as never,
      res: denied.res as never,
      method: "POST",
      pathname: `/api/browser-workspace/tabs/${tab?.id}/eval`,
      url: new URL(`http://local/api/browser-workspace/tabs/${tab?.id}/eval`),
      state: { runtime },
      readJsonBody: vi.fn(async () => ({ script: "1 + 1" })),
      json: denied.json as never,
      error: vi.fn(),
    });

    expect(denied.res.statusCode).toBe(400);
    expect(denied.res.body).toMatchObject({
      error: expect.stringContaining("connectorProvider and connectorAccountId"),
    });
  });
});
