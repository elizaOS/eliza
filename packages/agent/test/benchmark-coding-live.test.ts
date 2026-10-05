/** Runs the real CLI, provider, coding tools, database state and process shutdown. */
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import {
  createPlannerTokenPacer,
  plannerRateLimitEvidence,
  plannerWorkloadFixture,
  summarizePlannerObservation,
  summarizePlannerTrajectories,
  validatePlannerFixture,
} from "../../benchmarks/scripts/eliza-benchmark-scripts/agent/cerebras-planner-workload.ts";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const enabled = process.env.BENCHMARK_NATIVE_CODING_E2E === "1";
const repoRoot = path.resolve(import.meta.dirname, "../../..");

test
  .skipIf(!enabled)
  .each(["coding", "provider-failure", "incomplete", "recovered"] as const)(
  "native coding CLI verifies files and preserves exit status (%s)",
  async (scenario) => {
    const rejectModel = scenario === "provider-failure";
    const expectedSuccess = scenario === "coding" || scenario === "recovered";
    const configuredModel = process.env.BENCHMARK_NATIVE_MODEL;
    if (!configuredModel)
      throw new Error("Set BENCHMARK_NATIVE_MODEL for this live test");
    const model = rejectModel
      ? "__invalid_native_benchmark_model__"
      : configuredModel;
    const testSource =
      "import unittest\nfrom add import add\n\nclass TestAdd(unittest.TestCase):\n    def test_positive(self): self.assertEqual(add(2, 3), 5)\n    def test_negative(self): self.assertEqual(add(-4, -2), -6)\n    def test_zero(self): self.assertEqual(add(0, 0), 0)\n";
    const workspace = await mkdtemp(path.join(tmpdir(), "eliza-coding-e2e-"));
    const outputRoot = testOutputPath("agent-native-coding");
    await mkdir(outputRoot, { recursive: true });
    const output = await mkdtemp(path.join(outputRoot, "run-"));
    try {
      execFileSync("git", ["init", "-q", workspace]);
      await writeFile(
        path.join(workspace, ".gitignore"),
        "__pycache__/\n.pytest_cache/\n",
      );
      await writeFile(path.join(workspace, "test_add.py"), testSource);
      execFileSync("git", [
        "-C",
        workspace,
        "add",
        ".gitignore",
        "test_add.py",
      ]);
      execFileSync("git", [
        "-C",
        workspace,
        "-c",
        "user.name=Benchmark Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-qm",
        "Initialize fixture",
      ]);
      const taskPath = path.join(output, "task.json");
      await writeFile(
        taskPath,
        JSON.stringify({
          id: "native-coding-e2e",
          type: "coding",
          prompt:
            scenario === "incomplete"
              ? "Read the exact file required-input.txt and report its contents. The file must already exist; do not create it, invent contents, or substitute any other file. If it is missing, the requested task cannot be fulfilled."
              : scenario === "recovered"
                ? "Use SHELL to run python3 -m unittest -v before making any edits; it will fail because add.py is missing. Then fix the failure by using WRITE to create add.py defining add(a, b) returning a + b. Rerun the same python3 -m unittest -v command with SHELL and verify all tests pass. Do not modify test_add.py. Report both the initial failure and the successful recovery."
                : "Use WRITE to create add.py defining add(a, b) returning a + b. The workspace contains test_add.py; do not modify the tests. Use the native SHELL action to run python -m unittest -v in the workspace. Report the observed result.",
          context: { workspace },
        }),
      );
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        ELIZA_STATE_DIR: path.join(output, "state"),
        ELIZA_CONFIG_PATH: path.join(output, "state", "eliza.json"),
        CODING_TOOLS_WORKSPACE_ROOTS: workspace,
        OPENAI_SMALL_MODEL: model,
        OPENAI_LARGE_MODEL: model,
        CEREBRAS_MODEL: model,
        CEREBRAS_SMALL_MODEL: model,
        CEREBRAS_LARGE_MODEL: model,
        PYTHONDONTWRITEBYTECODE: "1",
        LOG_LEVEL: "info",
        NODE_ENV: "development",
      };
      // The real CLI must not inherit Vitest's background-service shortcuts.
      for (const key of Object.keys(env)) {
        if (
          key.startsWith("VITEST") ||
          key === "ELIZA_TEST_FAST" ||
          key === "ELIZA_TEST_HOME"
        ) {
          delete env[key];
        }
      }
      const child = spawn(
        "bun",
        [
          "--no-install",
          "--conditions=eliza-source",
          path.join(repoRoot, "packages/agent/src/bin.ts"),
          "benchmark",
          "--task",
          taskPath,
        ],
        {
          cwd: workspace,
          env,
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        if (process.platform !== "win32" && child.pid)
          process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      }, 240_000);
      let code: number | null;
      try {
        code = await new Promise<number | null>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", resolve);
        });
      } finally {
        clearTimeout(timer);
        await writeFile(path.join(output, "stdout.log"), Buffer.concat(stdout));
        await writeFile(path.join(output, "stderr.log"), Buffer.concat(stderr));
      }
      expect(
        timedOut,
        `CLI must terminate after its result; receipts: ${output}`,
      ).toBe(false);
      expect(code, `CLI exit status; receipts: ${output}`).toBe(
        expectedSuccess ? 0 : 1,
      );
      const rows = Buffer.concat(stdout)
        .toString()
        .split("\n")
        .flatMap((line) => {
          try {
            return [JSON.parse(line)];
          } catch {
            return [];
          }
        })
        .filter((row) => row?.id === "native-coding-e2e");
      expect(rows).toHaveLength(1);
      expect(rows[0].success).toBe(expectedSuccess);
      if (rejectModel) {
        expect(rows[0].error).toBeTruthy();
        return;
      }
      if (scenario === "incomplete") {
        expect(rows[0].request_fulfilled).toBe(false);
        expect(rows[0].error).toBeTruthy();
        await expect(
          readFile(path.join(workspace, "required-input.txt")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        return;
      }
      expect(rows[0].request_fulfilled).toBe(true);
      if (scenario === "recovered") {
        expect(rows[0].action_results).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ success: false }),
            expect.objectContaining({ success: true }),
          ]),
        );
      }
      expect(await readFile(path.join(workspace, "test_add.py"), "utf8")).toBe(
        testSource,
      );
      expect(rows[0].actions_taken).toEqual(
        expect.arrayContaining(["WRITE", "SHELL"]),
      );
      expect(await readFile(path.join(workspace, "add.py"), "utf8")).toContain(
        "def add",
      );
      // Independent verification prevents a model's claim from satisfying the test.
      execFileSync("python3", ["-m", "unittest", "-v"], {
        cwd: workspace,
        env,
      });
      execFileSync(
        "python3",
        [
          "-c",
          "from add import add; assert add(2, 3) == 5; assert add(-4, -2) == -6; assert add(0, 0) == 0",
        ],
        { cwd: workspace, env },
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
      // Retain transcripts and tool receipts, not per-run model/DB caches.
      for (const disposable of [
        "workspace/.elizadb",
        "models",
        "cache/node-compile",
      ]) {
        await rm(path.join(output, "state", disposable), {
          recursive: true,
          force: true,
        });
      }
    }
  },
  270_000,
);

test("paired planner fixtures validate actual file bytes and do not fabricate absent cache usage", async () => {
  const workspace = await mkdtemp(
    path.join(tmpdir(), "planner-fixture-validation-"),
  );
  try {
    const kinds: Record<string, number> = {};
    for (let index = 0; index < 30; index++) {
      const fixture = plannerWorkloadFixture(index, workspace);
      kinds[fixture.kind] = (kinds[fixture.kind] ?? 0) + 1;
      for (const [name, content] of Object.entries(fixture.filesAfter))
        await writeFile(path.join(workspace, name), content);
      expect(
        (
          await validatePlannerFixture(fixture, workspace, {
            text: fixture.expectedReply.join("\n"),
          })
        ).passed,
      ).toBe(true);
      const name = Object.keys(fixture.filesAfter)[0];
      await writeFile(path.join(workspace, name), "incorrect bytes");
      expect(
        (
          await validatePlannerFixture(fixture, workspace, {
            text: fixture.expectedReply.join("\n"),
          })
        ).passed,
      ).toBe(false);
    }
    expect(kinds).toEqual({
      "html-readback": 10,
      "read-compute": 10,
      "multiline-write": 5,
      "two-files": 5,
    });
    const summary = summarizePlannerTrajectories([
      {
        llmCalls: [
          { promptTokens: 100, completionTokens: 5, modelType: "PLANNER" },
        ],
        toolEvents: [],
      },
    ]);
    expect(summary.metrics.cacheReadInputTokens).toEqual({
      totalReported: 0,
      reportedCalls: 0,
      missingCalls: 1,
    });
    expect(summary.metrics.freshPromptTokens).toEqual({
      totalReported: 0,
      reportedCalls: 0,
      missingCalls: 1,
    });
    expect(summary.providerWireTTFT).toBeNull();
    expect(summary.successfulReadReceipts).toBe(0);
    const pacer = createPlannerTokenPacer({ fresh: 90_000, total: 400_000 }, 0);
    const reservation = { fresh: 60_000, total: 100_000 };
    expect(pacer.delay(reservation, 0)).toBe(0);
    pacer.reserve(reservation, 0);
    expect(pacer.delay(reservation, 0)).toBe(20_000);
    expect(pacer.delay(reservation, 20_000)).toBe(0);
    pacer.settle(reservation, { fresh: 90_000, total: 100_000 }, 20_000);
    expect(pacer.delay(reservation, 20_000)).toBe(20_000);

    const foreground = {
      trajectory: { id: "foreground", status: "completed" },
      llmCalls: [
        { modelType: "ACTION_PLANNER", promptTokens: 100, completionTokens: 5 },
      ],
    };
    const initial = summarizePlannerObservation([foreground]);
    expect(initial.foreground?.modelCalls).toBe(1);
    expect(initial.observedBackground).toBeNull();
    expect(plannerRateLimitEvidence({ failureKind: "rate_limited" }, [])).toBe(
      true,
    );
    expect(
      plannerRateLimitEvidence({}, [
        {
          llmCalls: [
            {
              providerMetadata: {
                error: "Too Many Requests: Tokens per minute limit exceeded",
              },
            },
          ],
        },
      ]),
    ).toBe(true);
    expect(
      plannerRateLimitEvidence({ text: "File saved" }, [
        { llmCalls: [{ providerMetadata: { error: "Invalid schema" } }] },
      ]),
    ).toBe(false);
    expect(initial.backgroundObservation).toBe("not-observed");
    const refreshed = summarizePlannerObservation([
      foreground,
      {
        trajectory: { id: "late-background", status: "completed" },
        llmCalls: [
          {
            modelType: "TEXT_SMALL",
            systemPrompt: "Evaluate the completed turn using supplied evidence",
            promptTokens: 30,
            completionTokens: 2,
          },
        ],
      },
    ]);
    expect(refreshed.foreground?.metrics.promptTokens.totalReported).toBe(100);
    expect(
      refreshed.observedBackground?.metrics.promptTokens.totalReported,
    ).toBe(30);
    expect(refreshed.allObserved.metrics.promptTokens.totalReported).toBe(130);
    expect(refreshed.backgroundObservation).toBe("observed-completed");
    expect(refreshed.futureBackgroundQuiescence).toBe("not-established");
    expect(initial.observedBackground).toBeNull();
    expect(
      summarizePlannerObservation([{ llmCalls: [{ modelType: "TEXT_SMALL" }] }])
        .unclassified?.modelCalls,
    ).toBe(1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test.each(["pacing", "request"] as const)(
  "planner benchmark stops gracefully during %s without a second dispatch",
  async (phase) => {
    const output = await mkdtemp(path.join(tmpdir(), "planner-stop-"));
    let messages = 0;
    let conversations = 0;
    let child: ReturnType<typeof spawn> | undefined;
    const server = createServer(async (request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const reply = (value: unknown) => {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(value));
      };
      if (url.pathname === "/api/conversations") {
        conversations++;
        reply({
          conversation: {
            id: `c${conversations}`,
            roomId: `r${conversations}`,
          },
        });
      } else if (url.pathname.endsWith("/messages")) {
        messages++;
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString());
        if (phase === "request") {
          child?.kill("SIGUSR1");
          // The response and real local write settle after the stop signal.
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        const matched = String(body.text).match(
          /^Create (.+?) containing exactly ("(?:[^"\\]|\\.)*")\./,
        );
        if (!matched) throw new Error("Unexpected fixture prompt");
        const content: string = JSON.parse(matched[2]);
        await writeFile(matched[1], content);
        reply({ text: content });
      } else if (url.pathname === "/api/trajectories") {
        reply({ total: 2, trajectories: [{ id: "fg" }, { id: "bg" }] });
      } else if (url.pathname === "/api/trajectories/fg") {
        reply({
          trajectory: { id: "fg", status: "completed" },
          llmCalls: [
            {
              modelType: "ACTION_PLANNER",
              promptTokens: 10,
              completionTokens: 2,
              cacheReadInputTokens: 0,
            },
          ],
          toolEvents: [
            {
              actionName: "READ",
              success: true,
              parameters: { file_path: "index.html" },
            },
          ],
        });
      } else if (url.pathname === "/api/trajectories/bg") {
        reply({
          trajectory: { id: "bg", status: "completed" },
          llmCalls: [
            {
              modelType: "TEXT_SMALL",
              systemPrompt: "Evaluate the completed turn",
              promptTokens: 2,
              completionTokens: 1,
              cacheReadInputTokens: 0,
            },
          ],
        });
      } else {
        response.statusCode = 404;
        reply({ error: "Unknown test route" });
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing test port");
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      child = spawn(
        "bun",
        [
          "--conditions=eliza-source",
          path.join(
            repoRoot,
            "packages/benchmarks/scripts/eliza-benchmark-scripts/agent/cerebras-planner-workload.ts",
          ),
        ],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            BUN_OPTIONS: "",
            BENCHMARK_PAIRS: "2",
            BENCHMARK_OUTPUT_DIR: output,
            BENCHMARK_BASELINE_URL: origin,
            BENCHMARK_CANDIDATE_URL: origin,
            BENCHMARK_MIN_TURN_INTERVAL_MS: "60000",
            BENCHMARK_FRESH_TOKENS_PER_MINUTE: "90000",
            BENCHMARK_TOTAL_TOKENS_PER_MINUTE: "400000",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const exited = once(child, "exit");
      if (phase === "pacing") {
        const deadline = Date.now() + 10000;
        let found = false;
        while (Date.now() < deadline) {
          try {
            const report = JSON.parse(
              await readFile(path.join(output, "report.json"), "utf8"),
            );
            if (report.status === "pacing") {
              found = true;
              break;
            }
          } catch {
            /* Report is created and replaced by the running child. */
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(found).toBe(true);
        child.kill("SIGUSR1");
      }
      expect((await exited)[0]).toBe(1);
      const report = JSON.parse(
        await readFile(path.join(output, "report.json"), "utf8"),
      );
      expect(report.status).toBe("interrupted-operator");
      expect(messages).toBe(1);
      expect(report.rows[0].response.text).toContain("CHECK-137");
      expect(report.rows[0].validation.passed).toBe(true);
      expect(
        JSON.parse(await readFile(report.rows[0].trajectoryFile, "utf8")),
      ).toHaveLength(2);
      expect(
        JSON.parse(await readFile(report.rows[0].finalTrajectoryFile, "utf8")),
      ).toHaveLength(2);
      if (phase === "pacing") expect(report.rows[1].dispatched).toBe(false);
      else expect(report.rows).toHaveLength(1);
    } finally {
      if (child?.exitCode === null) child.kill("SIGKILL");
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(output, { recursive: true, force: true });
    }
  },
  30000,
);
