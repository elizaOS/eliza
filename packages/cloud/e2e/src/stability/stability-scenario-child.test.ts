/**
 * Exercises real source runtime children, resource cleanup, and natural exit
 * for a model-free scenario and an injected provider-disposal failure. An owned
 * parent watchdog bounds each child independently of the test runner deadline.
 */

import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ServiceType } from "@elizaos/core";
import cloudScenario from "../../scenarios/cloud-stability-agent.scenario.ts";

async function waitForOwnedChild(
  child: Pick<Bun.Subprocess, "exited" | "exitCode" | "kill">,
  timeoutMs = 60_000,
): Promise<number> {
  let timedOut = false;
  const watchdog = setTimeout(() => {
    timedOut = true;
    if (child.exitCode === null) child.kill("SIGKILL");
  }, timeoutMs);
  try {
    const exitCode = await child.exited;
    if (timedOut)
      throw new Error(`owned child did not exit within ${timeoutMs}ms`);
    return exitCode;
  } finally {
    clearTimeout(watchdog);
  }
}

test("owned watchdog kills and settles a child that does not exit", async () => {
  const child = Bun.spawn(
    [process.execPath, "-e", "setInterval(() => {}, 1000)"],
    {
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  try {
    await expect(waitForOwnedChild(child, 50)).rejects.toThrow(
      "owned child did not exit",
    );
    await expect(child.exited).resolves.not.toBe(0);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
});

test("source scenario child exits naturally with zero runtime leaks", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "cloud-stability-natural-exit-"),
  );
  try {
    const policy = cloudScenario.contract.syntheticRuntimePolicy;
    expect(policy.allowedServiceTypes).toContain(ServiceType.MEMBERSHIP);
    const report = path.join(directory, "report.json");
    const quiescence = path.join(directory, "quiescence.json");
    const runtimeLedger = path.join(directory, "runtime.json");
    const poisonedMessagesDb = path.join(directory, "poisoned-host-chat.db");
    const poison = "synthetic mode must never open this host path";
    await writeFile(poisonedMessagesDb, poison, { mode: 0o000 });
    const startedAt = Date.now();
    const child = Bun.spawn(
      [
        process.execPath,
        "--conditions=eliza-source",
        path.resolve(
          import.meta.dirname,
          "../../scripts/stability-scenario-child.ts",
        ),
        "run",
        path.resolve(import.meta.dirname, "fixtures/natural-exit.scenario.ts"),
        "--report",
        report,
        "--run-dir",
        directory,
        "--runId",
        "cloud-stability-natural-exit",
      ],
      {
        cwd: path.resolve(import.meta.dirname, "../../../../.."),
        env: {
          PATH: process.env.PATH,
          TMPDIR: process.env.TMPDIR,
          SCENARIO_USE_DETERMINISTIC_MODEL: "1",
          ELIZA_STABILITY_CHILD_QUIESCENCE_LEDGER: quiescence,
          ELIZA_SYNTHETIC_RUNTIME_LEDGER: runtimeLedger,
          IMESSAGE_DB_PATH: poisonedMessagesDb,
          ELIZA_SYNTHETIC_RUNTIME_POLICY: JSON.stringify({
            allowedPluginNames: [
              ...policy.basePluginNames,
              policy.modelPluginNames.deterministic,
            ],
            allowedServiceTypes: policy.allowedServiceTypes,
          }),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const stdoutPromise = new Response(child.stdout).text();
    const stderrPromise = new Response(child.stderr).text();
    const exitCode = await waitForOwnedChild(child);
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
    expect(exitCode, `stdout:\n${stdout}\nstderr:\n${stderr}`).toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(60_000);
    const evidence = JSON.parse(await readFile(quiescence, "utf8")) as {
      handles: Array<{ constructorName: string; fd?: number }>;
      requests: unknown[];
    };
    expect(evidence.requests).toEqual([]);
    expect(
      evidence.handles.filter(
        (handle) =>
          handle.constructorName !== "Socket" ||
          (handle.fd !== undefined && handle.fd !== 1 && handle.fd !== 2),
      ),
    ).toEqual([]);
    const runtime = await readFile(runtimeLedger, "utf8");
    expect(runtime).not.toContain("imessage");
    expect(runtime).not.toContain("denied-undeclared-registration");
    await chmod(poisonedMessagesDb, 0o600);
    expect(await readFile(poisonedMessagesDb, "utf8")).toBe(poison);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 70_000);

test("failed provider disposal still closes the real runtime and exits naturally", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "cloud-provider-dispose-"),
  );
  const policy = cloudScenario.contract.syntheticRuntimePolicy;
  const child = Bun.spawn(
    [
      process.execPath,
      "--conditions=eliza-source",
      "--preload",
      path.resolve(
        import.meta.dirname,
        "../../scripts/stability-network-guard.mjs",
      ),
      path.resolve(import.meta.dirname, "fixtures/provider-dispose-child.ts"),
    ],
    {
      cwd: path.resolve(import.meta.dirname, "../../../../.."),
      env: {
        PATH: process.env.PATH,
        TMPDIR: process.env.TMPDIR,
        // A non-secret selection fixture; this child never requests inference.
        OPENAI_API_KEY: "synthetic-disposal-selection-only",
        ELIZA_SYNTHETIC_RUNTIME_LEDGER: path.join(directory, "runtime.json"),
        ELIZA_STABILITY_CHILD_NETWORK_LEDGER: path.join(
          directory,
          "network.jsonl",
        ),
        ELIZA_SYNTHETIC_RUNTIME_POLICY: JSON.stringify({
          allowedPluginNames: [
            ...policy.basePluginNames,
            policy.modelPluginNames.openai,
          ],
          allowedServiceTypes: policy.allowedServiceTypes,
        }),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  try {
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    const exitCode = await waitForOwnedChild(child);
    const exitedAt = Date.now();
    const [out, err] = await Promise.all([stdout, stderr]);
    const failureFile = Bun.file(path.join(directory, "runtime.json.failure"));
    const failure = (await failureFile.exists())
      ? await failureFile.text()
      : "";
    expect(
      exitCode,
      `stdout:\n${out}\nstderr:\n${err}\nchild failure:\n${failure}`,
    ).toBe(0);
    const receipt = JSON.parse(
      await readFile(path.join(directory, "runtime.json.completion"), "utf8"),
    ) as { cleanupCompleteAt: number; disposeCalls: number };
    expect(receipt.disposeCalls).toBe(1);
    // A rejected step must clear its five-second watchdog, not retain the process.
    expect(exitedAt - receipt.cleanupCompleteAt).toBeLessThan(3_500);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
    await rm(directory, { recursive: true, force: true });
  }
}, 70_000);
