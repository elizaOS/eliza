/** Verifies the real subprocess controller's reset, argv/env, evidence, and fail-closed contracts. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ScenarioCliSubprocessAdapter } from "./stability-subprocess-adapter.ts";

const DIGEST = "a".repeat(64);

describe("stability subprocess adapter", () => {
  const roots: string[] = [];
  const servers: Server[] = [];
  afterEach(() => {
    for (const server of servers.splice(0)) server.close();
    for (const root of roots.splice(0))
      rmSync(root, { recursive: true, force: true });
  });

  it("consumes the exact provider/model through a child and returns bounded evidence", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "stability-child-"));
    roots.push(root);
    const outputDir = path.join(root, "attempt");
    mkdirSync(outputDir);
    const cliPath = path.join(root, "fake-cli.mjs");
    writeFileSync(
      cliPath,
      `
      import { mkdirSync, writeFileSync } from "node:fs";
      import path from "node:path";
      const args = process.argv.slice(2);
      const value = (name) => args[args.indexOf(name) + 1];
      if (value("--provider") !== "openai") process.exit(90);
      if (process.env.OPENAI_SMALL_MODEL !== "exact-model" || process.env.OPENAI_LARGE_MODEL !== "exact-model") process.exit(91);
      if (!process.env.ELIZA_SYNTHETIC_RESET_ID) process.exit(92);
      const report = value("--report");
      const run = value("--run-dir");
      mkdirSync(path.join(run, "trajectories"), { recursive: true });
      writeFileSync(path.join(run, "stability-runtime-config.json"), JSON.stringify({ schemaVersion: "eliza.stability-runtime-config/v1", executionProfile: "simulated", providerName: "openai", smallModel: "exact-model", largeModel: "exact-model", resetId: process.env.ELIZA_SYNTHETIC_RESET_ID, generation: Number(process.env.ELIZA_SYNTHETIC_RESET_GENERATION), manifestHash: process.env.ELIZA_SYNTHETIC_MANIFEST_HASH, mockServiceIsolation: "fresh-process-simulated-profile" }));
      writeFileSync(report, JSON.stringify({ providerName: "openai", scenarios: [{ id: "scenario-a", status: "passed", turns: [{ tool: "SEND" }], finalChecks: [{ status: "passed" }] }] }));
      writeFileSync(path.join(run, "trajectories", "one.json"), JSON.stringify({ model: "exact-model", inputTokens: 5, outputTokens: 3, toolCalls: 1 }));
    `,
    );
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const target = JSON.parse(body);
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            schemaVersion: "eliza.synthetic-reset-proof/v1",
            resetId: "reset:1",
            generation: 1,
            manifestHash: DIGEST,
            executionStateHash: DIGEST,
            providerStateHash: DIGEST,
            modelRegistryHash: DIGEST,
            target,
          }),
        );
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    servers.push(server);
    const serverPort = (server.address() as AddressInfo).port;
    const adapter = new ScenarioCliSubprocessAdapter({
      scenarioDir: root,
      cliPath,
      resetUrl: `http://127.0.0.1:${serverPort}/reset`,
      resetToken: "test-token",
    });
    const target = {
      scenarioId: "scenario-a",
      model: { provider: "openai", model: "exact-model" },
    };
    const reset = await adapter.reset({ target, attemptNumber: 1, outputDir });
    expect(reset).toMatchObject({
      schemaVersion: "eliza.synthetic-reset-proof/v1",
      generation: 1,
    });
    const execution = await adapter.execute({
      target,
      attemptNumber: 1,
      attemptId: "run-attempt-01",
      outputDir,
      budgets: {
        timeoutMs: 5_000,
        maxInputTokens: 10,
        maxOutputTokens: 10,
        maxToolCalls: 2,
      },
      signal: new AbortController().signal,
    });
    expect(execution).toMatchObject({
      passed: true,
      inputTokens: 5,
      outputTokens: 3,
      toolCalls: 1,
    });
    expect(execution.evidence.providerReceipts).toEqual([
      expect.objectContaining({
        provider: "openai",
        model: "exact-model",
        resetId: "reset:1",
      }),
    ]);
    await adapter.terminate({ target, attemptNumber: 1, outputDir });
  });

  it("rejects an unversioned or target-substituted reset response", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "stability-reset-bad-"));
    roots.push(root);
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ schemaVersion: 0 }));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    servers.push(server);
    const serverPort = (server.address() as AddressInfo).port;
    const adapter = new ScenarioCliSubprocessAdapter({
      scenarioDir: root,
      cliPath: "unused",
      resetUrl: `http://127.0.0.1:${serverPort}/reset`,
      resetToken: "token",
    });
    await expect(
      adapter.reset({
        target: { scenarioId: "a", model: { provider: "openai", model: "m" } },
        attemptNumber: 1,
        outputDir: root,
      }),
    ).rejects.toThrow("unsupported schemaVersion");
  });

  it("kills an aborted subprocess instead of leaving a live child", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "stability-child-abort-"));
    roots.push(root);
    const outputDir = path.join(root, "attempt");
    mkdirSync(outputDir);
    const cliPath = path.join(root, "hang.mjs");
    writeFileSync(cliPath, "setInterval(() => {}, 1000);\n");
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            schemaVersion: "eliza.synthetic-reset-proof/v1",
            resetId: "abort-reset",
            generation: 1,
            manifestHash: DIGEST,
            executionStateHash: DIGEST,
            providerStateHash: DIGEST,
            modelRegistryHash: DIGEST,
            target: JSON.parse(body),
          }),
        );
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    servers.push(server);
    const adapter = new ScenarioCliSubprocessAdapter({
      scenarioDir: root,
      cliPath,
      resetUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/reset`,
      resetToken: "token",
    });
    const target = {
      scenarioId: "hang",
      model: { provider: "openai", model: "exact-model" },
    };
    await adapter.reset({ target, attemptNumber: 1, outputDir });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    await expect(
      adapter.execute({
        target,
        attemptNumber: 1,
        attemptId: "hang-1",
        outputDir,
        budgets: {
          timeoutMs: 1_000,
          maxInputTokens: 1,
          maxOutputTokens: 1,
          maxToolCalls: 1,
        },
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    await adapter.terminate({ target, attemptNumber: 1, outputDir });
  });
});
