/**
 * Exercises the live-stack child-output privacy boundary with hostile bytes.
 * The helper is deterministic and writes only schema-owned categories.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import {
  attachSafeChildOutputObserver,
  createSafeChildOutputObserver,
  formatSafeLiveStackDiagnostic,
  formatSafeLiveStackStartupFailure,
} from "./live-stack-safe-diagnostics.ts";

const HOSTILE_CHILD_OUTPUT =
  "agent_config={apiKey:sk-live-secret,email:user@example.com,wallet:0x1234,agentId:550e8400-e29b-41d4-a716-446655440000}";

describe("live-stack safe diagnostics", () => {
  test("projects hostile child output to one allowlisted event per channel", () => {
    const directory = mkdtempSync(
      join(tmpdir(), "live-stack-safe-diagnostics-"),
    );
    const artifactPath = join(directory, "backend.log");
    const consoleLines: string[] = [];

    try {
      const observer = createSafeChildOutputObserver({
        artifactPath,
        component: "live-runtime",
        writeConsole: (line) => consoleLines.push(line),
      });

      expect(consoleLines).toHaveLength(1);
      expect(JSON.parse(readFileSync(artifactPath, "utf8"))).toEqual({
        schema: "elizaos.live-stack-diagnostic/v1",
        category: "capture-started",
        component: "live-runtime",
      });

      observer.observe("stdout");
      (observer.observe as (untrustedChannel: string) => void)(
        HOSTILE_CHILD_OUTPUT,
      );
      for (let index = 0; index < 10_000; index += 1) {
        observer.observe("stdout");
        observer.observe("stderr");
      }

      const artifactLines = readFileSync(artifactPath, "utf8")
        .trim()
        .split("\n");
      expect(consoleLines).toHaveLength(3);
      expect(artifactLines).toEqual(consoleLines);
      expect(readFileSync(artifactPath).byteLength).toBeLessThan(512);

      const events = artifactLines.map((line) => JSON.parse(line));
      expect(events).toEqual([
        {
          schema: "elizaos.live-stack-diagnostic/v1",
          category: "capture-started",
          component: "live-runtime",
        },
        {
          schema: "elizaos.live-stack-diagnostic/v1",
          category: "child-output-observed",
          component: "live-runtime",
          channel: "stdout",
        },
        {
          schema: "elizaos.live-stack-diagnostic/v1",
          category: "child-output-observed",
          component: "live-runtime",
          channel: "stderr",
        },
      ]);

      const emitted = `${consoleLines.join("\n")}\n${artifactLines.join("\n")}`;
      expect(emitted).not.toContain(HOSTILE_CHILD_OUTPUT);
      expect(emitted).not.toContain("sk-live-secret");
      expect(emitted).not.toContain("user@example.com");
      expect(emitted).not.toContain("0x1234");
      expect(emitted).not.toContain("550e8400-e29b-41d4-a716-446655440000");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("consumes hostile child streams without forwarding their bytes", () => {
    const directory = mkdtempSync(
      join(tmpdir(), "live-stack-safe-child-streams-"),
    );
    const artifactPath = join(directory, "backend.log");
    const consoleLines: string[] = [];
    const stdout = new PassThrough();
    const stderr = new PassThrough();

    try {
      attachSafeChildOutputObserver({
        artifactPath,
        child: { stderr, stdout },
        component: "live-runtime",
        writeConsole: (line) => consoleLines.push(line),
      });

      stdout.write(HOSTILE_CHILD_OUTPUT);
      stdout.write(HOSTILE_CHILD_OUTPUT);
      stderr.write(HOSTILE_CHILD_OUTPUT);

      const artifactLines = readFileSync(artifactPath, "utf8")
        .trim()
        .split("\n");
      expect(artifactLines).toEqual(consoleLines);
      expect(artifactLines.map((line) => JSON.parse(line))).toEqual([
        {
          schema: "elizaos.live-stack-diagnostic/v1",
          category: "capture-started",
          component: "live-runtime",
        },
        {
          schema: "elizaos.live-stack-diagnostic/v1",
          category: "child-output-observed",
          component: "live-runtime",
          channel: "stdout",
        },
        {
          schema: "elizaos.live-stack-diagnostic/v1",
          category: "child-output-observed",
          component: "live-runtime",
          channel: "stderr",
        },
      ]);
      expect(artifactLines.join("\n")).not.toContain(HOSTILE_CHILD_OUTPUT);
    } finally {
      stdout.destroy();
      stderr.destroy();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("formats process and startup failures from closed fields only", () => {
    const diagnostic = formatSafeLiveStackDiagnostic({
      category: "process-failed",
      component: "renderer-build",
      exitCode: 17,
      hostileExtraField: HOSTILE_CHILD_OUTPUT,
    } as Parameters<typeof formatSafeLiveStackDiagnostic>[0]);

    expect(JSON.parse(diagnostic)).toEqual({
      schema: "elizaos.live-stack-diagnostic/v1",
      category: "process-failed",
      component: "renderer-build",
      exitCode: 17,
    });
    expect(diagnostic).not.toContain(HOSTILE_CHILD_OUTPUT);
    const hostileStartupFailure = new TypeError(HOSTILE_CHILD_OUTPUT);
    hostileStartupFailure.name = HOSTILE_CHILD_OUTPUT;
    hostileStartupFailure.stack = HOSTILE_CHILD_OUTPUT;
    const startupDiagnostic = formatSafeLiveStackStartupFailure(
      "optional-plugin-build",
      hostileStartupFailure,
    );
    expect(JSON.parse(startupDiagnostic)).toEqual({
      schema: "elizaos.live-stack-diagnostic/v1",
      category: "startup-failed",
      component: "optional-plugin-build",
      failureClass: "type-error",
    });
    expect(startupDiagnostic).not.toContain(HOSTILE_CHILD_OUTPUT);
    expect(
      JSON.parse(formatSafeLiveStackStartupFailure("live-runtime", {})),
    ).toEqual({
      schema: "elizaos.live-stack-diagnostic/v1",
      category: "startup-failed",
      component: "live-runtime",
      failureClass: "non-error",
    });
    const hostileProxy = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw new Error(HOSTILE_CHILD_OUTPUT);
        },
      },
    );
    expect(
      JSON.parse(
        formatSafeLiveStackStartupFailure("stub-runtime", hostileProxy),
      ),
    ).toEqual({
      schema: "elizaos.live-stack-diagnostic/v1",
      category: "startup-failed",
      component: "stub-runtime",
      failureClass: "non-error",
    });
    expect(() =>
      formatSafeLiveStackDiagnostic({
        category: "process-failed",
        component: HOSTILE_CHILD_OUTPUT,
        exitCode: 17,
      } as unknown as Parameters<typeof formatSafeLiveStackDiagnostic>[0]),
    ).toThrow("Unsupported live-stack diagnostic component.");
    expect(() =>
      formatSafeLiveStackDiagnostic({
        category: HOSTILE_CHILD_OUTPUT,
        component: "renderer-build",
      } as unknown as Parameters<typeof formatSafeLiveStackDiagnostic>[0]),
    ).toThrow("Unsupported live-stack diagnostic category.");
  });
});
