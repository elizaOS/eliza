/**
 * Verifies that bounded list reads preserve their typed adapters while forwarding
 * caller cancellation and timeout budgets to the base ElizaClient boundary.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setBootConfig } from "../config/boot-config";
import { ElizaClient } from "./client-base";
import "./client-agent";
import "./client-automations";
import "./client-scheduled-tasks";

describe("ElizaClient bounded list request options", () => {
  beforeEach(() => {
    setBootConfig({ branding: {} });
  });

  it("forwards connector options and retains response normalization", async () => {
    const client = new ElizaClient("http://agent.example:2138", "token");
    const fetchSpy = vi.fn(async () => ({ accounts: [] }));
    client.fetch = fetchSpy as typeof client.fetch;
    const controller = new AbortController();

    const result = await client.listConnectorAccounts("google", undefined, {
      timeoutMs: 6_000,
      signal: controller.signal,
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/connectors/google/accounts",
      { signal: controller.signal },
      { timeoutMs: 6_000 },
    );
    expect(result.accounts).toEqual([]);
    expect(result.provider).toBe("google");
  });

  it("forwards scheduled-task options and retains task normalization", async () => {
    const client = new ElizaClient("http://agent.example:2138", "token");
    const fetchSpy = vi.fn(async () => ({ tasks: "invalid" }));
    client.fetch = fetchSpy as typeof client.fetch;
    const controller = new AbortController();

    const result = await client.listScheduledTasks(
      { ownerVisibleOnly: true },
      { timeoutMs: 6_000, signal: controller.signal },
    );

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/lifeops/scheduled-tasks?ownerVisibleOnly=1",
      { signal: controller.signal },
      { timeoutMs: 6_000 },
    );
    expect(result).toEqual({ tasks: [] });
  });
});
