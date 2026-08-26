/**
 * Black-box tests the production inherited-pipe bootstrap parser in real Bun
 * subprocesses; no Cloud stack, scenario child, or model provider is started.
 */

import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import { MAX_REAL_MODEL_BOOTSTRAP_BYTES } from "./real-model-bootstrap.ts";

const parserUrl = pathToFileURL(
  path.resolve(import.meta.dirname, "real-model-bootstrap.ts"),
).href;

async function startParserProcess() {
  const directory = await mkdtemp(path.join(tmpdir(), "stability-bootstrap-"));
  const downstreamMarker = path.join(directory, "downstream-started");
  const script = `
    import { writeFileSync } from "node:fs";
    import { readRealModelBootstrap } from ${JSON.stringify(parserUrl)};
    await readRealModelBootstrap(3);
    writeFileSync(process.env.ELIZA_TEST_DOWNSTREAM_MARKER, "started");
    process.stdout.write("accepted");
  `;
  const child = spawn(
    process.execPath,
    ["--conditions=eliza-source", "-e", script],
    {
      cwd: directory,
      env: {
        PATH: process.env.PATH,
        ELIZA_TEST_DOWNSTREAM_MARKER: downstreamMarker,
      },
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    },
  );
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const bootstrapPipe = child.stdio[3] as Writable;
  bootstrapPipe.on("error", () => {
    // error-policy:J5 child exit is observed below; EPIPE is expected on rejection.
  });
  const exited = once(child, "exit").then(([code, signal]) => ({
    code: code as number | null,
    signal: signal as NodeJS.Signals | null,
  }));
  return {
    bootstrapPipe,
    child,
    directory,
    downstreamMarker,
    exited,
    stderr,
    stdout,
  };
}

async function finish(
  running: Awaited<ReturnType<typeof startParserProcess>>,
  payload: string | Buffer,
) {
  running.bootstrapPipe.end(payload);
  const [exit, stdout, stderr] = await Promise.all([
    running.exited,
    running.stdout,
    running.stderr,
  ]);
  return { exit, stdout, stderr };
}

async function cleanup(
  running: Awaited<ReturnType<typeof startParserProcess>>,
) {
  await rm(running.directory, { recursive: true, force: true });
}

test.each([
  {
    name: "malformed JSON",
    payload: '{"credentialValue":"MALFORMED_BOOTSTRAP_SECRET"',
    expected: "real-model bootstrap must be valid JSON",
    secret: "MALFORMED_BOOTSTRAP_SECRET",
  },
  {
    name: "invalid schema",
    payload: JSON.stringify({
      version: 1,
      credentialEnvironment: "OPENAI_API_KEY",
      credentialValue: "INVALID_SCHEMA_BOOTSTRAP_SECRET",
      meterAttestationKey: "not-a-valid-attestation-key",
    }),
    expected: "real-model bootstrap has an invalid schema",
    secret: "INVALID_SCHEMA_BOOTSTRAP_SECRET",
  },
  {
    name: "oversized payload",
    payload: Buffer.from(
      `OVERSIZED_BOOTSTRAP_SECRET${"x".repeat(MAX_REAL_MODEL_BOOTSTRAP_BYTES + 1)}`,
    ),
    expected: "real-model bootstrap exceeds its byte limit",
    secret: "OVERSIZED_BOOTSTRAP_SECRET",
  },
])("fails closed on $name without starting downstream", async (fixture) => {
  const running = await startParserProcess();
  try {
    const result = await finish(running, fixture.payload);
    expect(result.exit.code).not.toBe(0);
    expect(result.stderr).toContain(fixture.expected);
    expect(result.stderr).not.toContain(fixture.secret);
    expect(result.stdout).not.toContain(fixture.secret);
    expect(existsSync(running.downstreamMarker)).toBe(false);
  } finally {
    await cleanup(running);
  }
});

test("waits for EOF and rejects a truncated bootstrap without downstream startup", async () => {
  const running = await startParserProcess();
  const secret = "TRUNCATED_BOOTSTRAP_SECRET";
  try {
    running.bootstrapPipe.write(`{"version":1,"credentialValue":"${secret}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(running.child.exitCode).toBeNull();
    expect(existsSync(running.downstreamMarker)).toBe(false);
    running.bootstrapPipe.end();
    const [exit, stdout, stderr] = await Promise.all([
      running.exited,
      running.stdout,
      running.stderr,
    ]);
    expect(exit.code).not.toBe(0);
    expect(stderr).toContain("real-model bootstrap must be valid JSON");
    expect(stderr).not.toContain(secret);
    expect(stdout).not.toContain(secret);
    expect(existsSync(running.downstreamMarker)).toBe(false);
  } finally {
    await cleanup(running);
  }
});

test("accepts one valid bounded bootstrap and exposes no secret output", async () => {
  const running = await startParserProcess();
  const secret = "VALID_BOUNDED_BOOTSTRAP_SECRET";
  try {
    const result = await finish(
      running,
      JSON.stringify({
        version: 1,
        credentialEnvironment: "OPENAI_API_KEY",
        credentialValue: secret,
        meterAttestationKey: "a".repeat(64),
      }),
    );
    expect(result.exit, result.stderr).toEqual({ code: 0, signal: null });
    expect(result.stdout).toBe("accepted");
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain(secret);
    expect(await readFile(running.downstreamMarker, "utf8")).toBe("started");
  } finally {
    await cleanup(running);
  }
});
