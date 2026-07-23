/** Verifies workflow transport budgets and completed-execution response contracts. */

import { describe, expect, it, vi } from "vitest";
import { ElizaClient } from "./client-base";
import "./client-workflow";

describe("ElizaClient workflow transport", () => {
  it("keeps generation requests inside the longer Cloud proxy budget", async () => {
    const client = new ElizaClient("http://agent.example:31337", "token");
    const fetch = vi.fn(async () => ({}));
    client.fetch = fetch as typeof client.fetch;

    await client.generateWorkflowDefinition({ prompt: "Build a daily digest" });
    await client.resolveWorkflowClarification({
      draft: {},
      resolutions: [{ paramPath: "nodes[0].parameters.to", value: "me" }],
    });

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "/api/workflow/workflows/generate",
      {
        method: "POST",
        body: JSON.stringify({ prompt: "Build a daily digest" }),
      },
      { timeoutMs: 330_000 },
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "/api/workflow/workflows/resolve-clarification",
      {
        method: "POST",
        body: JSON.stringify({
          draft: {},
          resolutions: [{ paramPath: "nodes[0].parameters.to", value: "me" }],
        }),
      },
      { timeoutMs: 330_000 },
    );
  });

  it("keeps synchronous Smithers runs alive beyond the generic request timeout", async () => {
    const client = new ElizaClient("http://agent.example:31337", "token");
    const execution = {
      id: "execution-1",
      workflowId: "workflow/1",
      status: "success" as const,
      mode: "manual" as const,
      startedAt: "2026-07-17T23:10:15.346Z",
      stoppedAt: "2026-07-17T23:10:27.887Z",
      finished: true,
    };
    const fetch = vi.fn(async () => ({ execution }));
    client.fetch = fetch as typeof client.fetch;

    await expect(client.runWorkflowDefinition("workflow/1")).resolves.toEqual(
      execution,
    );
    expect(fetch).toHaveBeenCalledWith(
      "/api/workflow/workflows/workflow%2F1/run",
      { method: "POST" },
      { timeoutMs: 11 * 60_000 },
    );
  });

  it("fails closed when the run response omits its execution", async () => {
    const client = new ElizaClient("http://agent.example:31337", "token");
    client.fetch = vi.fn(async () => ({})) as typeof client.fetch;

    await expect(client.runWorkflowDefinition("workflow-1")).rejects.toThrow(
      "Workflow run response did not include an execution.",
    );
  });
});
