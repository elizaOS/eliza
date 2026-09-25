/** Runs the real CLI, provider, coding tools, database state and process shutdown. */
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
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
                ? "Use SHELL to run python3 -m unittest -v before making any edits; it will fail because add.py is missing. Then fix the failure by using FILE to create add.py defining add(a, b) returning a + b. Rerun the same python3 -m unittest -v command with SHELL and verify all tests pass. Do not modify test_add.py. Report both the initial failure and the successful recovery."
                : "Use FILE to create add.py defining add(a, b) returning a + b. The workspace contains test_add.py; do not modify the tests. Use the native SHELL action to run python -m unittest -v in the workspace. Report the observed result.",
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
        expect.arrayContaining(["FILE", "SHELL"]),
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
