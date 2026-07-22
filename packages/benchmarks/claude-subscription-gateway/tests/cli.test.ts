/** Exercises private artifact projection and the real child-process signal lifecycle without model I/O. */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  inspectBrokerReadiness,
  runGatewayCli,
  writeAuditJsonl,
} from "../src/cli.js";
import {
  buildClaudeCodeManagedEnvironment,
  type CredentialLeaseBroker,
  type GatewayAuditRecord,
} from "../src/index.js";

const CLI_PATH = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

async function waitForFile(
  path: string,
  child: ChildProcess,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("Gateway CLI exited before publishing readiness.");
    }
    await delay(20);
  }
  throw new Error("Gateway CLI did not publish readiness before the deadline.");
}

function waitForExit(
  child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
}

function withoutApiBillingEnvironment(): NodeJS.ProcessEnv {
  return buildClaudeCodeManagedEnvironment(process.env);
}

describe("gateway CLI", () => {
  it("projects allowlisted redacted audit fields to private JSONL", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-gateway-audit-"));
    const auditFile = join(directory, "cohort.jsonl");
    const secret = "raw-prompt-and-tool-arguments";
    const record: GatewayAuditRecord & {
      prompt: string;
      toolArguments: { secret: string };
    } = {
      requestId: "request-1",
      recordedAt: "2026-07-20T12:00:00.000Z",
      harness: "openclaw",
      transport: "claude-agent-sdk",
      credentialSource: "claude-code-managed",
      sdkVersion: "0.3.200",
      sdkApiKeySource: "none",
      freshSession: true,
      toolExecution: "capture-only",
      serializer: "openai-full-history-v1",
      responseMode: "sse",
      modelRequested: "claude-opus-4-8",
      modelEffective: "claude-opus-4-8-actual",
      reasoningEffort: "high",
      claudeCodeVersion: "test-cli",
      messageCount: 2,
      messageRoles: ["system", "user"],
      toolNames: ["weather"],
      toolChoice: "auto",
      parallelToolCalls: true,
      toolCallNames: ["weather"],
      promptSha256: "a".repeat(64),
      systemPromptSha256: "b".repeat(64),
      toolSchemaSha256: "c".repeat(64),
      toolSchemaSha256ByName: { weather: "e".repeat(64) },
      requestSha256: "d".repeat(64),
      contentAttestation: null,
      queueWaitMs: 12,
      serviceMs: 34,
      status: "succeeded",
      finishReason: "tool_calls",
      resultSubtype: "error_max_turns",
      terminalReason: "max_turns",
      unappliedParameters: [],
      errorCode: null,
      prompt: secret,
      toolArguments: { secret },
    };

    try {
      await writeAuditJsonl(auditFile, [record]);
      const text = await readFile(auditFile, "utf8");
      const parsed: unknown = JSON.parse(text.trim());

      expect(statMode(await stat(auditFile))).toBe(PRIVATE_MODE);
      expect(text).not.toContain(secret);
      expect(parsed).toMatchObject({
        schema_version: 2,
        audit_sequence: 0,
        previous_record_sha256: "0".repeat(64),
        record_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        credential_source: "claude-code-managed",
        sdk_api_key_source: "none",
        response_mode: "sse",
        reasoning_effort: "high",
        tool_schema_sha256_by_name: { weather: "e".repeat(64) },
        queue_wait_ms: 12,
        service_ms: 34,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("publishes readiness privately, stays alive, and flushes audit after SIGTERM even when readiness was consumed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-gateway-cli-"));
    const readyFile = join(directory, "cohort.ready.json");
    const auditFile = join(directory, "cohort.audit.jsonl");
    const child = spawn(
      "bun",
      [CLI_PATH, "--ready-file", readyFile, "--audit-file", auditFile],
      {
        cwd: directory,
        env: withoutApiBillingEnvironment(),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const exit = waitForExit(child);
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    try {
      await waitForFile(readyFile, child);
      const readinessText = await readFile(readyFile, "utf8");
      const readinessValue: unknown = JSON.parse(readinessText);
      if (!isReadinessView(readinessValue)) {
        throw new Error("Readiness did not match the public lifecycle schema.");
      }
      const readiness = readinessValue;
      const harnessTokens = readiness.harness_tokens;

      expect(statMode(await stat(readyFile))).toBe(PRIVATE_MODE);
      expect(readiness.status).toBe("ready");
      expect(typeof readiness.origin).toBe("string");
      expect(readiness.base_url).toBe(`${readiness.origin}/v1`);
      expect(isHarnessTokenMap(harnessTokens)).toBe(true);
      if (!isHarnessTokenMap(harnessTokens)) {
        throw new Error(
          "Readiness did not contain the expected harness token map.",
        );
      }
      expect(Object.keys(harnessTokens).sort()).toEqual([
        "eliza",
        "hermes",
        "openclaw",
      ]);
      expect(new Set(Object.values(harnessTokens)).size).toBe(3);
      expect(
        Object.values(harnessTokens).every((token) =>
          /^[A-Za-z0-9_-]{43}$/.test(token),
        ),
      ).toBe(true);
      const health = await fetch(`${readiness.origin}/health`);
      expect(health.status).toBe(200);

      await rm(readyFile, { force: true });
      expect(child.kill("SIGTERM")).toBe(true);
      const outcome = await Promise.race([
        exit,
        delay(5_000).then(() => {
          throw new Error("Gateway CLI did not exit after SIGTERM.");
        }),
      ]);

      expect(outcome).toEqual({ code: 0, signal: null });
      expect(existsSync(readyFile)).toBe(false);
      expect(existsSync(auditFile)).toBe(true);
      expect(statMode(await stat(auditFile))).toBe(PRIVATE_MODE);
      expect(await readFile(auditFile, "utf8")).toBe("");
      expect(stdout).toBe("");
      expect(stderr).toBe("");
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await Promise.race([exit, delay(1_000)]);
      }
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects ambient API billing credentials before server startup or readiness", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-gateway-policy-"));
    const readyFile = join(directory, "cohort.ready.json");
    const auditFile = join(directory, "cohort.audit.jsonl");
    let startCalled = false;

    try {
      await expect(
        runGatewayCli(["--ready-file", readyFile, "--audit-file", auditFile], {
          environment: { ANTHROPIC_API_KEY: "raw-key-must-be-rejected" },
          startGateway: async () => {
            startCalled = true;
            throw new Error("start must not be reached");
          },
        }),
      ).rejects.toMatchObject({ code: "api_billing_environment_forbidden" });
      expect(startCalled).toBe(false);
      expect(existsSync(readyFile)).toBe(false);
      expect(existsSync(auditFile)).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("distinguishes an empty linked pool from configured-but-unselectable accounts", async () => {
    const emptyLease = async () => {
      throw new Error("an empty provider must not be probed");
    };
    const empty: CredentialLeaseBroker = {
      lease: emptyLease,
      report: async () => ({ ok: true }),
      release: () => ({ ok: true }),
      health: () => ({ providers: [] }),
    };
    await expect(inspectBrokerReadiness(empty)).resolves.toEqual({
      linkedPoolConfigured: false,
      linkedPoolSelectable: false,
    });

    const unavailableLease = async () => {
      throw new Error("an unselectable provider must not be probed");
    };
    const unavailable: CredentialLeaseBroker = {
      lease: unavailableLease,
      report: async () => ({ ok: true }),
      release: () => ({ ok: true }),
      health: () => ({
        providers: [
          {
            providerId: "anthropic-subscription",
            total: 2,
            selectable: 0,
          },
        ],
      }),
    };
    await expect(inspectBrokerReadiness(unavailable)).resolves.toEqual({
      linkedPoolConfigured: true,
      linkedPoolSelectable: false,
    });
  });
});

const PRIVATE_MODE = 0o600;

function statMode(
  stats: NonNullable<Awaited<ReturnType<typeof stat>>>,
): number {
  return Number(stats.mode) & 0o777;
}

function isHarnessTokenMap(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((token) => typeof token === "string")
  );
}

interface ReadinessView {
  status: unknown;
  origin: string;
  base_url: unknown;
  harness_tokens: unknown;
}

function isReadinessView(value: unknown): value is ReadinessView {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof Reflect.get(value, "origin") === "string" &&
    Reflect.has(value, "status") &&
    Reflect.has(value, "base_url") &&
    Reflect.has(value, "harness_tokens")
  );
}
