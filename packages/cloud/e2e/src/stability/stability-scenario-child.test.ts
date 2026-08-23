/**
 * Runs the real source CLI child with a minimal model-free scenario and proves
 * it exits naturally after writing its report, with no active requests or
 * non-stdio handles retained by runtime cleanup.
 */

import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import cloudScenario from "../../scenarios/cloud-stability-agent.scenario.ts";

test("source scenario child exits naturally with zero runtime leaks", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "cloud-stability-natural-exit-"),
  );
  try {
    const policy = cloudScenario.contract.syntheticRuntimePolicy;
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
    expect(await child.exited).toBe(0);
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
