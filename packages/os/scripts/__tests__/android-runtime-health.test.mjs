import assert from "node:assert/strict";
import net from "node:net";
import { test } from "node:test";
import { probeAndroidHealth } from "../android/runtime-health.mjs";
import { androidSocketFetch } from "../aosp/lib/android-socket-fetch.mjs";

test("health probe uses the authenticated NDJSON bridge and removes only its own serial-bound forward", async (t) => {
  const server = net.createServer((socket) => {
    socket.once("data", (data) => {
      const request = JSON.parse(data.toString());
      assert.equal(request.method, "http_request");
      assert.equal(request.payload.path, "/api/health");
      assert.equal(
        request.payload.headers.authorization,
        "Bearer private-token",
      );
      socket.end(
        `${JSON.stringify({ id: request.id, ok: true, result: { status: 200, body: '{"ready":true}' } })}\n`,
      );
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const port = String(server.address().port);
  const calls = [];
  const result = await probeAndroidHealth(
    "adb",
    "SERIAL",
    "private-token",
    (tool, args) => {
      assert.equal(tool, "adb");
      assert(!args.join(" ").includes("private-token"));
      calls.push(args);
      return port;
    },
  );
  assert.deepEqual(result, { status: 200, body: '{"ready":true}' });
  assert.deepEqual(calls, [
    ["-s", "SERIAL", "forward", "tcp:0", "localabstract:eliza_local_agent_v1"],
    ["-s", "SERIAL", "forward", "--remove", `tcp:${port}`],
  ]);
});

test("failed bridge and body reads still remove the forward; cleanup failure cannot report success", async () => {
  for (const stage of ["connect", "body", "cleanup"]) {
    const calls = [];
    await assert.rejects(
      probeAndroidHealth(
        "adb",
        "SERIAL",
        "token",
        (_tool, args) => {
          calls.push(args);
          if (stage === "cleanup" && args.includes("--remove"))
            throw new Error("cleanup failed");
          return "12345";
        },
        async (_url, options) => {
          assert(options.signal instanceof AbortSignal);
          if (stage === "connect") throw new Error("connection failed");
          return {
            status: 200,
            text: async () => {
              if (stage === "body") throw new Error("body failed");
              return '{"ready":true}';
            },
          };
        },
      ),
      /failed/,
    );
    assert.equal(calls.length, 2);
    assert(calls[1].includes("--remove"));
  }
});

test("invalid serial, token and allocated ports fail closed before contacting the runtime", async () => {
  for (const [serial, token, port] of [
    ["-x", "token", "123"],
    ["SERIAL", "a\nb", "123"],
    ["SERIAL", "token", "0"],
    ["SERIAL", "token", "65536"],
    ["SERIAL", "token", "123\n456"],
  ]) {
    await assert.rejects(
      probeAndroidHealth(
        "adb",
        serial,
        token,
        () => port,
        () => {
          assert.fail("must not contact runtime");
        },
      ),
      /invalid/,
    );
  }
});

test("malformed, mismatched, closed and stalled bridge responses fail and clean up", async (t) => {
  for (const fault of ["json", "id", "closed", "timeout"]) {
    const server = net.createServer((socket) => {
      socket.on("error", () => {});
      socket.once("data", () => {
        if (fault === "json") socket.end("invalid\n");
        if (fault === "id")
          socket.end(
            `${JSON.stringify({
              id: "wrong",
              ok: true,
              result: { status: 200, body: '{"ready":true}' },
            })}\n`,
          );
        if (fault === "closed") socket.end();
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => server.close());
    let removed = false;
    await assert.rejects(
      probeAndroidHealth(
        "adb",
        "SERIAL",
        "token",
        (_tool, args) => {
          if (args.includes("--remove")) removed = true;
          return String(server.address().port);
        },
        (url, options) =>
          androidSocketFetch(url, {
            ...options,
            signal: AbortSignal.timeout(100),
          }),
      ),
    );
    assert.equal(removed, true);
  }
});
