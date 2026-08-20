import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { provisionJobId } from "./provision-response";

const stateFile = join(tmpdir(), `hetzner-e2e-provision-${process.pid}.json`);
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.CLOUD_E2E_API_KEY;
  delete process.env.HETZNER_E2E_STATE_FILE;
  if (existsSync(stateFile)) rmSync(stateFile);
});

describe("Hetzner E2E provisioning response", () => {
  test("returns the job id for dedicated asynchronous provisioning", () => {
    expect(provisionJobId(202, { data: { jobId: "job-123" } })).toBe("job-123");
  });

  test("accepts an already-running shared-runtime agent without a job", () => {
    expect(
      provisionJobId(200, {
        source: "shared_runtime",
        data: { status: "running" },
      }),
    ).toBeNull();
  });

  test("fails closed on malformed or non-running success responses", () => {
    expect(() => provisionJobId(202, { data: {} })).toThrow(
      "Provision response missing jobId",
    );
    expect(() =>
      provisionJobId(200, {
        source: "shared_runtime",
        data: { status: "stopped" },
      }),
    ).toThrow("not a running shared-runtime agent");
  });

  test("deploy script completes against an immediate shared-runtime response", async () => {
    process.env.CLOUD_E2E_API_KEY = "test-api-key";
    process.env.HETZNER_E2E_STATE_FILE = stateFile;
    const requests: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/api/v1/eliza/agents")) {
        return Response.json(
          { success: true, created: true, data: { id: "agent-123" } },
          { status: 201 },
        );
      }
      if (url.endsWith("/api/v1/eliza/agents/agent-123/provision")) {
        return Response.json({
          success: true,
          source: "shared_runtime",
          data: { id: "agent-123", status: "running" },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;

    await import(`./hetzner-e2e-deploy-agent?test=${Date.now()}`);

    expect(requests).toHaveLength(2);
    expect(JSON.parse(readFileSync(stateFile, "utf8"))).toMatchObject({
      agent_id: "agent-123",
    });
  });
});
