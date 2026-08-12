/**
 * Exercises the app-core compatibility middleware and upstream agent auth gate
 * together over a real HTTP listener. The regression contract proves the
 * per-agent message and event routes pass through app-core without becoming
 * public: missing or invalid credentials stop at 401, while both supported
 * service credential forms reach the owning agent handlers.
 */
import type { startApiServer as startApiServerType } from "@elizaos/agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApiServer } from "./server";

const ENV_KEYS = [
  "AGENT_SERVER_SHARED_SECRET",
  "ELIZA_API_BIND",
  "ELIZA_API_TOKEN",
  "ELIZA_DISABLE_AUTO_API_TOKEN",
  "ELIZA_REQUIRE_LOCAL_AUTH",
] as const;

const OWNER_TOKEN = "compat-owner-token";
const SERVER_TOKEN = "compat-server-token";
const AGENT_ID = "00000000-0000-0000-0000-000000000001";

type ApiServer = Awaited<ReturnType<typeof startApiServerType>>;

let savedEnv: Record<(typeof ENV_KEYS)[number], string | undefined>;
let server: ApiServer | null = null;
let baseUrl = "";

async function post(
  route: "message" | "event",
  headers: Record<string, string> = {},
): Promise<Response> {
  const body =
    route === "message"
      ? { userId: "review-user", text: "hello" }
      : { type: "review_probe", userId: "review-user", payload: { ok: true } };
  return fetch(`${baseUrl}/api/agents/${AGENT_ID}/${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe.sequential("per-agent compat pass-through auth", () => {
  beforeAll(async () => {
    savedEnv = Object.fromEntries(
      ENV_KEYS.map((key) => [key, process.env[key]]),
    ) as Record<(typeof ENV_KEYS)[number], string | undefined>;
    process.env.ELIZA_API_BIND = "127.0.0.1";
    process.env.ELIZA_REQUIRE_LOCAL_AUTH = "1";
    process.env.ELIZA_DISABLE_AUTO_API_TOKEN = "1";
    process.env.ELIZA_API_TOKEN = OWNER_TOKEN;
    process.env.AGENT_SERVER_SHARED_SECRET = SERVER_TOKEN;

    server = await startApiServer({
      port: 0,
      skipDeferredStartupWork: true,
    });
    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    await server?.close();
    server = null;
    for (const key of ENV_KEYS) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  for (const route of ["message", "event"] as const) {
    it(`keeps /${route} closed to missing and invalid credentials`, async () => {
      expect((await post(route)).status).toBe(401);
      expect(
        (
          await post(route, {
            authorization: "Bearer invalid-token",
          })
        ).status,
      ).toBe(401);
    });

    it(`lets /${route} reach the agent handler with an API bearer`, async () => {
      const response = await post(route, {
        authorization: `Bearer ${OWNER_TOKEN}`,
      });
      expect(response.status).toBe(route === "message" ? 503 : 200);
    });

    it(`lets /${route} reach the agent handler with a server token`, async () => {
      const response = await post(route, {
        "x-server-token": SERVER_TOKEN,
      });
      expect(response.status).toBe(route === "message" ? 503 : 200);
    });
  }
});
