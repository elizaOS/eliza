/** Exercise local Worker proxy recovery over a real loopback HTTP connection. */
import { afterEach, expect, test } from "bun:test";
import { api } from "../test/e2e/_helpers/api";

const originalBaseUrl = process.env.TEST_API_BASE_URL;
const proxyFailure =
  "Error: Network connection lost.\n    at async Object.fetch (file:///checkout/node_modules/.bun/miniflare@4/node_modules/miniflare/dist/src/workers/core/entry.worker.js:4765:22)";
let server: ReturnType<typeof Bun.serve> | undefined;

afterEach(() => {
  server?.stop(true);
  server = undefined;
  if (originalBaseUrl === undefined) delete process.env.TEST_API_BASE_URL;
  else process.env.TEST_API_BASE_URL = originalBaseUrl;
});

function start(body: string, contentType = "text/plain;charset=UTF-8") {
  let calls = 0;
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      calls++;
      return calls === 1
        ? new Response(body, {
            status: 500,
            headers: { "Content-Type": contentType },
          })
        : Response.json({ error: "Authentication required" }, { status: 401 });
    },
  });
  process.env.TEST_API_BASE_URL = server.url.origin;
  return () => calls;
}

test("retries a local Miniflare lost-connection GET and retains the auth rejection", async () => {
  const calls = start(proxyFailure);
  const response = await api.get("/api/v1/advertising/accounts/test");
  expect(response.status).toBe(401);
  expect(calls()).toBe(2);
});

test("never replays a mutation after a proxy connection failure", async () => {
  const calls = start(proxyFailure);
  expect((await api.post("/mutation", {})).status).toBe(500);
  expect(calls()).toBe(1);
});

test.each([
  ["Error: Network connection lost.", "text/plain"],
  [proxyFailure, "application/problem+json"],
  [
    proxyFailure.replace(
      "miniflare/dist/src/workers/core/entry.worker.js",
      "app/handler.js",
    ),
    "text/plain",
  ],
])("does not retry application failures (%s)", async (body, contentType) => {
  const calls = start(body, contentType);
  expect((await api.get("/failure")).status).toBe(500);
  expect(calls()).toBe(1);
});
