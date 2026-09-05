/** Exercises the published ESM client in Node against a real HTTP boundary, including rejected credentials and redirects. */
import { expect, test } from "bun:test";

test("Node loads the built client and preserves HTTP authorization boundaries", async () => {
  const requests: string[] = [];
  let redirectedRequests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/credential-sink") {
        redirectedRequests += 1;
        return Response.json({ ok: true, data: [] });
      }
      requests.push(pathname);
      if (request.headers.get("X-Steward-Key") !== "node-test-key") {
        return Response.json(
          { ok: false, error: "Unauthorized" },
          { status: 401 },
        );
      }
      if (pathname === "/agents/redirect/policies") {
        return new Response(null, {
          status: 302,
          headers: { Location: "/credential-sink" },
        });
      }
      return Response.json({ ok: true, data: [] });
    },
  });
  const script = `
    import assert from "node:assert/strict";
    import { LoginClient, LoginApiError } from "@elizaos/login";
    const options = { baseUrl: process.env.LOGIN_TEST_URL, requestTimeoutMs: 2000 };
    const client = new LoginClient({ ...options, apiKey: "node-test-key" });
    assert.deepEqual(await client.getPolicies("example"), []);
    await assert.rejects(
      () => new LoginClient({ ...options, apiKey: "wrong-key" }).getPolicies("example"),
      error => error instanceof LoginApiError && error.status === 401,
    );
    await assert.rejects(
      () => client.getPolicies("redirect"),
      error => error instanceof LoginApiError && error.status === 0,
    );
  `;
  const child = Bun.spawn(["node", "--input-type=module", "-e", script], {
    cwd: new URL("../../../", import.meta.url).pathname,
    env: { ...process.env, LOGIN_TEST_URL: `http://127.0.0.1:${server.port}` },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ exitCode, stdout, stderr }).toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
    expect(requests).toEqual([
      "/agents/example/policies",
      "/agents/example/policies",
      "/agents/redirect/policies",
    ]);
    expect(redirectedRequests).toBe(0);
  } finally {
    child.kill();
    await child.exited;
    await server.stop(true);
  }
}, 15_000);
