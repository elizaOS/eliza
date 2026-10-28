import { expect, test } from "bun:test";
import { ElizaCloudClient } from "./client.js";

function clientReturning(body: unknown, status: number): ElizaCloudClient {
  return new ElizaCloudClient({
    baseUrl: "http://cloud.test",
    apiKey: "api-key",
    fetchImpl: (async () =>
      Response.json(body, {
        status,
        headers: status === 202 ? { "Retry-After": "5" } : {},
      })) as unknown as typeof fetch,
  });
}

/** Exact 202 body of `POST /api/v1/eliza/agents/:agentId/pairing-token` while the agent is not running. */
const startingBody = {
  success: true,
  data: {
    agentId: "agent-1",
    status: "starting",
    jobId: "job-1",
    alreadyInProgress: false,
    retryAfterMs: 5000,
    message:
      "Agent is not running yet. Resume has been requested; retry after the suggested interval.",
  },
};

/** Exact 200 body once the agent runs. */
const readyBody = {
  success: true,
  data: {
    token: "pair-token",
    redirectUrl: "https://agent.example/ui?token=pair-token",
    expiresIn: 60,
  },
};

test("a 202 starting answer is reported as starting with the retry interval, not as a token", async () => {
  const result = await clientReturning(startingBody, 202).getAgentPairingToken(
    "agent-1",
  );

  expect(result.kind).toBe("starting");
  if (result.kind !== "starting") throw new Error("expected a starting result");
  expect(result.jobId).toBe("job-1");
  expect(result.retryAfterMs).toBe(5000);
  expect(result.alreadyInProgress).toBe(false);
});

test("a 200 answer is reported as ready with the token", async () => {
  const result = await clientReturning(readyBody, 200).getAgentPairingToken(
    "agent-1",
  );

  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") throw new Error("expected a ready result");
  expect(result.token).toBe("pair-token");
  expect(result.redirectUrl).toBe("https://agent.example/ui?token=pair-token");
  expect(result.expiresIn).toBe(60);
});

test("a bare 200 body from an older deployment is still reported as ready", async () => {
  const result = await clientReturning(
    readyBody.data,
    200,
  ).getAgentPairingToken("agent-1");

  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") throw new Error("expected a ready result");
  expect(result.token).toBe("pair-token");
  expect(result.expiresIn).toBe(60);
});
