import { describe, expect, it } from "vitest";
import { ElizaClient } from "../client-base";
import "../client-workflow";

function recordingClient() {
  const requests: Array<{ url: string; method?: string; body?: unknown }> = [];
  const client = new ElizaClient("https://agent.example");
  client.setRequestTransport({
    request: async (url, init) => {
      requests.push({
        url: String(url),
        method: init?.method,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
      });
      return new Response(
        JSON.stringify({ id: "flow", active: true, versionId: "v2" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  });
  return { client, requests };
}

describe("workflow activation", () => {
  it("names the reviewed version so a changed workflow is refused", async () => {
    const { client, requests } = recordingClient();
    await client.activateWorkflowDefinition("flow", "v2");
    expect(requests).toEqual([
      {
        url: "https://agent.example/api/workflow/workflows/flow/activate",
        method: "POST",
        body: { expectedVersionId: "v2" },
      },
    ]);
  });

  it("keeps the version-free request for callers without a reviewed version", async () => {
    const { client, requests } = recordingClient();
    await client.activateWorkflowDefinition("flow");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.body).toBeUndefined();
  });
});
