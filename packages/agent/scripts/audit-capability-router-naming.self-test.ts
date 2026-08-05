// Exercises audit capability router naming.self test automation behavior with deterministic script fixtures.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "audit-capability-router-naming.ts",
);

async function main(): Promise<void> {
  const workspace = await mkdtemp(
    join(tmpdir(), "capability-router-naming-audit-self-test-"),
  );
  try {
    const auditedRoot = join(workspace, "packages", "agent", "docs");
    const cleanDir = join(auditedRoot, "clean");
    const badDir = join(auditedRoot, "bad");
    await mkdir(cleanDir, { recursive: true });
    await mkdir(badDir, { recursive: true });
    await writeFile(
      join(cleanDir, "architecture.md"),
      "Remote capability endpoints should use capability-router vocabulary.\n",
      "utf8",
    );
    await writeFile(
      join(badDir, "architecture.md"),
      "This runtime should install a new satellite plugin abstraction.\n",
      "utf8",
    );

    const clean = await runAudit(cleanDir);
    if (clean.exitCode !== 0) {
      throw new Error(
        `clean naming fixture should pass, got ${clean.exitCode}: ${clean.output}`,
      );
    }

    const bad = await runAudit(badDir);
    if (bad.exitCode === 0) {
      throw new Error("bad naming fixture unexpectedly passed.");
    }
    if (
      !bad.output.includes(
        'legacy "satellite"/"carrot" vocabulary is forbidden',
      )
    ) {
      throw new Error(`bad naming fixture failed incorrectly: ${bad.output}`);
    }

    const production = await runAudit();
    if (production.exitCode !== 0) {
      throw new Error(
        `production naming audit should pass, got ${production.exitCode}: ${production.output}`,
      );
    }
    const productionReport = parseJsonOutput(production.output);
    if (
      !Array.isArray(productionReport.auditedRoots) ||
      !productionReport.auditedRoots.includes("packages/agent/docs")
    ) {
      throw new Error(
        `production naming audit must cover packages/agent/docs: ${production.output}`,
      );
    }
    if (
      !Array.isArray(productionReport.allowedLegacyMentionFiles) ||
      !productionReport.allowedLegacyMentionFiles.includes(
        "packages/agent/docs/capability-router-remote-plugins.md",
      )
    ) {
      throw new Error(
        `production naming audit must report the architecture doc allowlist: ${production.output}`,
      );
    }
    console.log("Capability-router naming audit self-test passed.");
  } finally {
    await rm(workspace, { force: true, recursive: true });
  }
}

async function runAudit(root?: string): Promise<{
  exitCode: number;
  output: string;
}> {
  const env = { ...process.env };
  if (root) {
    env.CAPABILITY_ROUTER_NAMING_AUDIT_ROOTS = root;
  } else {
    delete env.CAPABILITY_ROUTER_NAMING_AUDIT_ROOTS;
  }
  const proc = Bun.spawn({
    cmd: [process.execPath, scriptPath],
    env,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, output: `${stdout}${stderr}` };
}

function parseJsonOutput(output: string): Record<string, unknown> {
  try {
    return JSON.parse(output) as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `expected audit output to be JSON, got: ${output}\n${error}`,
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
