/**
 * GET /api/v1/eliza/lifeops/github-complete `target` is GitHub OAuth
 * landing identity, not leftover tax on Life Ops inbox bools, X
 * connectionRole, or influencer bookings party. Stock develop treated
 * any non-exact `agent` token as owner, so `target=AGENT` with an
 * agent_id landed on the connections tab instead of agents (or a 400).
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import * as realAgentGithubReturn from "@/lib/services/agent-github-return";

const createLifeOpsGithubReturnResponse = mock(
  () => new Response("ok", { status: 200 }),
);

mock.module("@/lib/services/agent-github-return", () => ({
  ...realAgentGithubReturn,
  createLifeOpsGithubReturnResponse,
  normalizePostMessageTargetOrigin:
    realAgentGithubReturn.normalizePostMessageTargetOrigin,
}));

const route = (await import("./route")).default;
const app = new Hono().route("/api/v1/eliza/lifeops/github-complete", route);

function complete(query: string) {
  return app.request(`/api/v1/eliza/lifeops/github-complete${query}`);
}

const CONNECTED = "?github_connected=true&connection_id=conn-1";

describe("GET /api/v1/eliza/lifeops/github-complete landing identity", () => {
  beforeEach(() => {
    createLifeOpsGithubReturnResponse.mockClear();
  });

  test.each(["", "&target=", "&target=owner"])(
    "accepts %s as the owner connections landing",
    async (targetQuery) => {
      const response = await complete(`${CONNECTED}${targetQuery}`);
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toContain(
        "/cloud/settings?tab=connections",
      );
      expect(createLifeOpsGithubReturnResponse).not.toHaveBeenCalled();
    },
  );

  test("accepts target=agent with agent_id as the agent landing", async () => {
    const response = await complete(
      `${CONNECTED}&target=agent&agent_id=agent-1`,
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain(
      "/cloud/settings?tab=agents",
    );
  });

  test.each(["AGENT", "OWNER", "foo", "1e2"])(
    "rejects target=%s before redirect or postMessage",
    async (token) => {
      const response = await complete(
        `${CONNECTED}&target=${encodeURIComponent(token)}&agent_id=agent-1`,
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("Invalid target");
      expect(createLifeOpsGithubReturnResponse).not.toHaveBeenCalled();
    },
  );
});
