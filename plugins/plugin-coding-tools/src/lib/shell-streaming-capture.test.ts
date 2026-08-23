/**
 * Exercises encrypted foreground capture through real bounded redaction and
 * immutable artifact publication without replacing the filesystem boundary.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { IAgentRuntime } from "@elizaos/core";
import { captureHostExecutionBaseline } from "@elizaos/shared/host-execution-env";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { redactShellText } from "../shell/redaction.js";
import { runShell } from "./run-shell.js";
import { readShellOutputArtifactPage } from "./shell-output-artifact.js";
import { ForegroundShellCapture } from "./shell-streaming-capture.js";

const OWNER_AGENT = "00000000-0000-4000-8000-000000000001";
const OWNER_CONVERSATION = "00000000-0000-4000-8000-000000000002";

describe("bounded foreground shell capture", () => {
  let stateDir: string;
  let previousStateDir: string | undefined;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "shell-capture-bounded-"),
    );
    previousStateDir = process.env.ELIZA_STATE_DIR;
    process.env.ELIZA_STATE_DIR = stateDir;
  });

  afterEach(async () => {
    if (previousStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
    else process.env.ELIZA_STATE_DIR = previousStateDir;
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("publishes zero-byte streams", async () => {
    const capture = await ForegroundShellCapture.create();
    const result = await capture.finalize(runtime(), outcome());

    expect(result.artifact.stdout).toMatchObject({ bytes: 0, characters: 0 });
    expect(result.projection).toMatchObject({ stdout: "", stderr: "" });
  });

  it("returns the private artifact through the host runShell boundary", async () => {
    captureHostExecutionBaseline();
    const result = await runShell(runtime(), {
      command: "printf bounded-host",
      cwd: process.cwd(),
      timeoutMs: 10_000,
      captureScope: {
        ownerAgentId: OWNER_AGENT,
        ownerConversationId: OWNER_CONVERSATION,
      },
    });
    if (!result.artifact) throw new Error(JSON.stringify(result));
    expect(result.projection).toBeDefined();
    expect(result.stdout).toBe("bounded-host");
  });

  it("redacts cross-window secrets and PEM while preserving exact Unicode reassembly", async () => {
    const secret = "marigold9-window-boundary-secret";
    const configuredRuntime = runtime(secret);
    const capture = await ForegroundShellCapture.create();
    const prefix = `${"🙂row\n".repeat(90_000)}configured:`;
    capture.write("stdout", `${prefix}${secret.slice(0, 13)}`);
    capture.write("stdout", `${secret.slice(13)}\n-----BEGIN PRI`);
    capture.write(
      "stdout",
      "VATE KEY-----\naGVsbG8tc2VjcmV0LWtleQ==\n-----END PRIVATE KEY-----\ntail界\n",
    );

    const result = await capture.finalize(configuredRuntime, outcome());
    const observed = await retrieve(result.artifact.handle);
    const source = `${prefix}${secret}\n-----BEGIN PRIVATE KEY-----\naGVsbG8tc2VjcmV0LWtleQ==\n-----END PRIVATE KEY-----\ntail界\n`;
    const expected = redactShellText(configuredRuntime, source);
    expect(observed).toBe(expected);
    expect(result.projection.stdout).not.toContain(secret);
    expect(result.projection.stdoutComplete).toBe(false);
  }, 30_000);

  it("fails closed on ciphertext tamper and removes every unpublished file", async () => {
    const capture = await ForegroundShellCapture.create();
    capture.write("stdout", "private plaintext that must never publish\n");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const encrypted = path.join(capture.directory, "stdout.enc");
    const file = await fs.open(encrypted, "r+");
    try {
      await file.write(Buffer.from([0xff]), 0, 1, 0);
    } finally {
      await file.close();
    }

    await expect(capture.finalize(runtime(), outcome())).rejects.toThrow();
    await expect(fs.stat(capture.directory)).rejects.toMatchObject({
      code: "ENOENT",
    });
    const root = path.join(stateDir, "coding-tools", "shell-output");
    expect(await fs.readdir(root)).toEqual([".artifact-key"]);
  });

  it("aborts cleanly and rejects malformed source text", async () => {
    const capture = await ForegroundShellCapture.create();
    expect(() => capture.write("stdout", "\ud800")).toThrow(
      "malformed Unicode",
    );
    capture.write("stdout", "discard me");
    await capture.abort();
    await expect(fs.stat(capture.directory)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("fails closed instead of buffering an unbounded sensitive record", async () => {
    const capture = await ForegroundShellCapture.create();
    capture.write("stdout", "Authorization: Custom key=");
    for (let index = 0; index < 65; index += 1) {
      capture.write("stdout", "x".repeat(64 * 1024));
    }

    await expect(capture.finalize(runtime(), outcome())).rejects.toThrow(
      "cannot be redacted safely",
    );
    await expect(fs.stat(capture.directory)).rejects.toMatchObject({
      code: "ENOENT",
    });
  }, 30_000);

  it("keeps process memory bounded from 1 MiB through 32 MiB", async () => {
    const reports = [];
    for (const bytes of [1, 10, 32].map((mib) => mib * 1024 * 1024)) {
      const child = fileURLToPath(
        new URL("../../scripts/shell-capture-memory-child.ts", import.meta.url),
      );
      const { stdout } = await promisify(execFile)(
        process.execPath,
        ["--expose-gc", "--import", "tsx", child, String(bytes)],
        {
          cwd: path.dirname(child),
          maxBuffer: 1024 * 1024,
          timeout: 180_000,
        },
      );
      reports.push(JSON.parse(stdout.trim()) as MemoryReport);
    }
    for (const report of reports) {
      expect(report.expectedSha256).toBe(report.observedSha256);
      expect(report.pageBytesRead).toBeLessThan(report.storedBytes * 5);
      expect(report.throughputMiBPerSecond).toBeGreaterThan(0);
    }
    const deltas = reports.map((report) => report.peakRss - report.baselineRss);
    for (const [index, delta] of deltas.entries()) {
      expect(delta).toBeLessThan(160 * 1024 * 1024);
      expect(
        (reports[index]?.peakHeap ?? Number.POSITIVE_INFINITY) -
          (reports[index]?.baselineHeap ?? 0),
      ).toBeLessThan(160 * 1024 * 1024);
    }
    // Separate V8 processes have JIT/GC baseline jitter, so compare both a hard
    // ceiling and memory per source byte instead of requiring adjacent samples
    // to land within a narrow absolute band.
    expect(deltas[2] ?? Number.POSITIVE_INFINITY).toBeLessThan(
      (deltas[1] ?? 0) + 64 * 1024 * 1024,
    );
    expect((deltas[2] ?? Number.POSITIVE_INFINITY) / 32).toBeLessThan(
      deltas[0] ?? 0,
    );
  }, 600_000);

  async function retrieve(handle: string): Promise<string> {
    let text = "";
    let offset = 0;
    while (true) {
      const page = await readShellOutputArtifactPage({
        handle,
        stream: "stdout",
        offset,
        limit: 20_000,
        requesterAgentId: OWNER_AGENT,
        requesterConversationId: OWNER_CONVERSATION,
      });
      if (!page.ok) throw new Error(page.message);
      text += page.value.text;
      if (page.value.complete) return text;
      offset = page.value.nextOffset;
    }
  }
});

interface MemoryReport {
  storedBytes: number;
  pageBytesRead: number;
  throughputMiBPerSecond: number;
  baselineRss: number;
  baselineHeap: number;
  peakRss: number;
  peakHeap: number;
  expectedSha256: string;
  observedSha256: string;
}

function runtime(secret?: string): IAgentRuntime {
  return {
    getService: () => null,
    redactSecrets: (text: string) =>
      secret ? text.replaceAll(secret, "[REDACTED:TEST_SECRET]") : text,
    character: {
      settings: { secrets: secret ? { TEST_SECRET: secret } : {} },
    },
  } as unknown as IAgentRuntime;
}

function outcome() {
  return {
    exitCode: 0,
    timedOut: false,
    signal: null,
    ownerAgentId: OWNER_AGENT,
    ownerConversationId: OWNER_CONVERSATION,
  };
}
