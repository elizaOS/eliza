/** Exercises LifeOps GitHub popup-return flag validation at the redirect boundary. */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const createLifeOpsGithubReturnResponse = mock(
  (_args: { postMessage: boolean }) => new Response("popup", { status: 200 }),
);

mock.module("@/lib/services/agent-github-return", () => ({
  createLifeOpsGithubReturnResponse,
  normalizePostMessageTargetOrigin: (value: string) => new URL(value).origin,
}));

const route = (await import("./route")).default;
const app = new Hono().route("/api/v1/eliza/lifeops/github-complete", route);

function complete(query: string) {
  return app.request(`/api/v1/eliza/lifeops/github-complete${query}`);
}

const CONNECTED = "?github_connected=true&connection_id=conn-1";

describe("GET /api/v1/eliza/lifeops/github-complete post_message identity", () => {
  beforeEach(() => {
    createLifeOpsGithubReturnResponse.mockClear();
  });

  test.each(["", "&post_message="])(
    "accepts %s as the dashboard-redirect completion path",
    async (postMessageQuery) => {
      const response = await complete(`${CONNECTED}${postMessageQuery}`);
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toContain(
        "/cloud/settings?tab=connections",
      );
      expect(createLifeOpsGithubReturnResponse).not.toHaveBeenCalled();
    },
  );

  test("accepts post_message=1 as the popup postMessage completion path", async () => {
    const response = await complete(`${CONNECTED}&post_message=1`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("popup");
    expect(createLifeOpsGithubReturnResponse).toHaveBeenCalledTimes(1);
    const args = createLifeOpsGithubReturnResponse.mock.calls[0]?.[0] as {
      postMessage: boolean;
    };
    expect(args.postMessage).toBe(true);
  });

  test.each(["true", "TRUE", "0", "false", "yes", "foo", "1e2"])(
    "rejects post_message=%s before redirect or postMessage",
    async (token) => {
      const response = await complete(
        `${CONNECTED}&post_message=${encodeURIComponent(token)}`,
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("Invalid post_message");
      expect(createLifeOpsGithubReturnResponse).not.toHaveBeenCalled();
    },
  );

  test.each([
    "&post_message=1&post_message=1",
    "&post_message=1&post_message=0",
    "&post_message=&post_message=1",
    "&post_message=foo&post_message=1",
  ])(
    "rejects duplicate post_message values in %s before redirect",
    async (query) => {
      const response = await complete(`${CONNECTED}${query}`);
      expect(response.status).toBe(400);
      expect(createLifeOpsGithubReturnResponse).not.toHaveBeenCalled();
    },
  );
});
