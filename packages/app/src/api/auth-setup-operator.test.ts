/**
 * POST /api/auth/setup creates the first owner. It is public at the outer
 * gate, so the handler itself must require the operator: a trusted local
 * request or the configured API token. Otherwise anyone who can reach a server
 * with no owner yet (non-loopback bind, tunnel, cloud container) claims it.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

const store = {
  ownerExists: false,
  created: 0,
  async hasOwnerIdentity() {
    return this.ownerExists;
  },
  async createIdentity() {
    this.created += 1;
  },
  async createSession(session: unknown) {
    return session;
  },
};

vi.mock("../services/auth-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/auth-store")>()),
  authStoreForHost: () => store,
}));

const { handleAuthSessionRoutes, _resetAuthSessionRoutesLimiter } =
  await import("./auth-session-routes");

const TOKEN = "setup-operator-test-token";
let server: http.Server;
let port: number;

beforeAll(async () => {
  vi.stubEnv("ELIZA_API_TOKEN", TOKEN);
  vi.stubEnv("ELIZA_REQUIRE_LOCAL_AUTH", "0");
  vi.stubEnv("ELIZA_CLOUD_PROVISIONED", "0");
  server = http.createServer((req, res) => {
    void handleAuthSessionRoutes(req, res, {} as never);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.unstubAllEnvs();
});

beforeEach(() => {
  _resetAuthSessionRoutesLimiter();
  store.created = 0;
});

async function setup(headers: Record<string, string>): Promise<number> {
  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/api/auth/setup",
        headers: { "content-type": "application/json", ...headers },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.end(
      JSON.stringify({
        displayName: "Claimer",
        password: "Correct-Horse-Battery-9",
      }),
    );
  });
}

it("refuses a remote caller without the API token and creates no owner", async () => {
  store.ownerExists = false;
  // A request through a tunnel or proxy: non-loopback Host header.
  expect(await setup({ host: "agent.example.com" })).toBe(403);
  expect(store.created).toBe(0);
});

it("lets the operator through (local request or the API token)", async () => {
  // With an owner already present, an admitted caller reaches the existing
  // "already initialized" answer instead of the operator refusal.
  store.ownerExists = true;
  expect(await setup({ host: `127.0.0.1:${port}` })).toBe(409);
  expect(
    await setup({
      host: "agent.example.com",
      authorization: `Bearer ${TOKEN}`,
    }),
  ).toBe(409);
});
