/**
 * Shell custom actions report the command's real result: they ask the
 * terminal route to capture output and fail when the command exits non-zero.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { CustomActionDef } from "@elizaos/contracts";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { buildTestHandler } from "../src/runtime/custom-actions.ts";

let server: http.Server;
let reply: { status: number; body: Record<string, unknown> };
const requests: Record<string, unknown>[] = [];

function shellAction(command: string): CustomActionDef {
  return {
    id: "6b0f7a52-1b8e-4c1e-9d55-2f4a9e0c1b01",
    name: "CHECK_DISK",
    description: "Check disk usage",
    similes: [],
    parameters: [],
    handler: { type: "shell", command },
    enabled: true,
    createdAt: "2026-11-08T00:00:00.000Z",
    updatedAt: "2026-11-08T00:00:00.000Z",
  };
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      if (req.url === "/api/terminal/run") requests.push(JSON.parse(raw));
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  vi.stubEnv("ELIZA_API_PORT", String((server.address() as AddressInfo).port));
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

it("fails with stderr when the command exits non-zero", async () => {
  reply = {
    status: 200,
    body: {
      ok: true,
      runId: "run-1",
      exitCode: 2,
      stdout: "",
      stderr: "df: /nope: No such file or directory",
      timedOut: false,
      truncated: false,
    },
  };
  const result = await buildTestHandler(shellAction("df -h /nope"))({});
  expect(result.ok).toBe(false);
  expect(result.output).toContain("No such file or directory");
  expect(result.output).toContain("Exit code 2");
  expect(requests.at(-1)).toMatchObject({
    command: "df -h /nope",
    captureOutput: true,
  });
});

it("preserves complete stdout and refuses an incomplete terminal result", async () => {
  const stdout = `Filesystem Size\n${"complete command output ".repeat(4_000)}\n`;
  reply = {
    status: 200,
    body: {
      ok: true,
      runId: "run-2",
      exitCode: 0,
      stdout,
      stderr: "",
      timedOut: false,
      truncated: false,
    },
  };
  const result = await buildTestHandler(shellAction("df -h /"))({});
  expect(result).toEqual({
    ok: true,
    output: stdout,
  });
  reply.body.truncated = true;
  const incomplete = await buildTestHandler(shellAction("df -h /"))({});
  expect(incomplete.ok).toBe(false);
  expect(incomplete.output).toContain("Terminal result is incomplete");
  expect(incomplete.output).toContain("Do not repeat it automatically");
});

it("fails when the command times out", async () => {
  reply = {
    status: 200,
    body: {
      ok: true,
      runId: "run-3",
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: true,
      maxDurationMs: 1000,
    },
  };
  const result = await buildTestHandler(shellAction("sleep 5"))({});
  expect(result.ok).toBe(false);
  expect(result.output).toContain("Timed out after 1000ms");
});

it("fails with the route's reason when the run is refused", async () => {
  reply = { status: 403, body: { error: "Shell access is disabled" } };
  const result = await buildTestHandler(shellAction("df -h /"))({});
  expect(result).toEqual({
    ok: false,
    output: "Terminal request failed: Shell access is disabled",
  });
});
