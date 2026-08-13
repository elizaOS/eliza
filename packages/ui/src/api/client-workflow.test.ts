/** Verifies native Smithers workflow transport paths, budgets, and fail-closed response contracts. */
import { describe, expect, it, vi } from "vitest";
import { ElizaClient } from "./client-base";
import "./client-workflow";

describe("ElizaClient native workflow transport", () => {
  it("uses Cloud workflow routes and encoded Smithers identifiers", async () => {
    const client = new ElizaClient("http://agent.example:31337", "token");
    const execution = {
      id: "run-1",
      workflowId: "workflow/1",
      status: "queued",
    };
    const fetch = vi.fn(async () => ({ execution }));
    client.fetch = fetch as typeof client.fetch;

    await expect(client.runWorkflowDefinition("workflow/1")).resolves.toEqual(
      execution,
    );
    expect(fetch).toHaveBeenCalledWith(
      "/api/workflow/workflows/workflow%2F1/run",
      { method: "POST" },
      { timeoutMs: 30_000, skipResume: true },
    );
  });

  it("fails closed when a run response omits its execution", async () => {
    const client = new ElizaClient("http://agent.example:31337", "token");
    client.fetch = vi.fn(async () => ({})) as typeof client.fetch;
    await expect(client.runWorkflowDefinition("workflow-1")).rejects.toThrow(
      "Workflow run response did not include an execution.",
    );
  });
});
