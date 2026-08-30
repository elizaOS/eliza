/** Provides the headless command-line entrypoint for true multi-runtime arena evaluations. */

import fs from "node:fs";
import path from "node:path";
import {
  BUILT_IN_ARENA_SEATS,
  BUILT_IN_ARENA_TURNS,
  runMultiAgentArena,
} from "./multi-agent-arena.ts";
import {
  AUTONOMOUS_LIGHTHOUSE_SCOPED_FACTS,
  AUTONOMOUS_LIGHTHOUSE_SEATS,
  AUTONOMOUS_LIGHTHOUSE_TURNS,
  autonomousLighthouseDealReached,
  evaluateAutonomousLighthouseAssertions,
} from "./multi-agent-sales-autonomous.ts";
import {
  evaluateLighthouseAssertions,
  LIGHTHOUSE_PRIVATE_FACTS,
  LIGHTHOUSE_SEATS,
  LIGHTHOUSE_TURNS,
} from "./multi-agent-sales-lighthouse.ts";

function writeJsonAtomically(outputPath: string, value: unknown): void {
  const temporaryOutputPath = `${outputPath}.${process.pid}.tmp`;
  fs.writeFileSync(
    temporaryOutputPath,
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
  fs.renameSync(temporaryOutputPath, outputPath);
}

function trajectoryFilesForAgent(
  trajectoryDir: string,
  agentId: string,
): string[] {
  const agentDir = path.join(trajectoryDir, agentId);
  if (!fs.existsSync(agentDir)) return [];
  return fs
    .readdirSync(agentDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) =>
      path.relative(trajectoryDir, path.join(agentDir, entry.name)),
    )
    .sort();
}

function isFinishedAgentTrajectory(
  trajectoryDir: string,
  relativePath: string,
  agentId: string,
): boolean {
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(path.join(trajectoryDir, relativePath), "utf8"),
    );
    if (parsed === null || typeof parsed !== "object") return false;
    const record = parsed as Record<string, unknown>;
    if (record.agentId !== agentId || record.status !== "finished")
      return false;
    if (!Array.isArray(record.stages)) return false;
    return record.stages.some((stage) => {
      if (stage === null || typeof stage !== "object") return false;
      const stageRecord = stage as Record<string, unknown>;
      return (
        stageRecord.kind === "messageHandler" &&
        typeof stageRecord.endedAt === "number"
      );
    });
  } catch {
    // error-policy:J3 malformed trajectory evidence is an explicit failed check.
    return false;
  }
}

function readOutputPath(argv: readonly string[]): string {
  const raw = argv
    .find((arg) => arg.startsWith("--output="))
    ?.slice(9)
    .trim();
  if (!raw) {
    throw new Error(
      "usage: multi-agent-arena --output=/absolute/or/relative/report.json",
    );
  }
  return path.resolve(raw);
}

async function main(): Promise<void> {
  const outputPath = readOutputPath(process.argv.slice(2));
  const runDir = path.dirname(outputPath);
  fs.mkdirSync(runDir, { recursive: true });
  if (
    /^(?:1|true|yes|on)$/iu.test(
      process.env.ELIZA_DISABLE_TRAJECTORY_LOGGING ?? "",
    )
  ) {
    throw new Error(
      "[multi-agent-arena] ELIZA_DISABLE_TRAJECTORY_LOGGING prevents required trajectory evidence",
    );
  }
  const runId = crypto.randomUUID();
  const trajectoryDir = path.join(runDir, "trajectories", runId);
  process.env.ELIZA_TRAJECTORY_LOGGING = "1";
  process.env.ELIZA_TRAJECTORY_DIR = trajectoryDir;
  const autonomousLighthouse = process.argv.includes(
    "--scenario=lighthouse-autonomous",
  );
  const lighthouse = process.argv.includes("--scenario=lighthouse");
  const seats = autonomousLighthouse
    ? AUTONOMOUS_LIGHTHOUSE_SEATS
    : lighthouse
      ? LIGHTHOUSE_SEATS
      : BUILT_IN_ARENA_SEATS;
  const turns = autonomousLighthouse
    ? AUTONOMOUS_LIGHTHOUSE_TURNS
    : lighthouse
      ? LIGHTHOUSE_TURNS
      : BUILT_IN_ARENA_TURNS;
  const report = await runMultiAgentArena({
    seats,
    turns,
    preferredProvider: "cli",
    maxPeerRounds: autonomousLighthouse ? 6 : lighthouse ? 2 : 1,
    runId,
    ...(lighthouse
      ? {
          privateFacts: LIGHTHOUSE_PRIVATE_FACTS,
          evaluateAssertions: evaluateLighthouseAssertions,
        }
      : {}),
    ...(autonomousLighthouse
      ? {
          scopedFacts: AUTONOMOUS_LIGHTHOUSE_SCOPED_FACTS,
          evaluateAssertions: evaluateAutonomousLighthouseAssertions,
          shouldStopPeerRounds: autonomousLighthouseDealReached,
        }
      : {}),
  });
  const filesByAgent = Object.fromEntries(
    report.seats.map((seat) => [
      seat.agentId,
      trajectoryFilesForAgent(trajectoryDir, seat.agentId),
    ]),
  );
  const trajectoryCapturePassed = report.seats.every((seat) => {
    const files = filesByAgent[seat.agentId] ?? [];
    const expectedTurns = report.turns.filter(
      (turn) => !turn.injectFailureSeatIds?.includes(seat.id),
    ).length;
    return (
      files.length >= expectedTurns &&
      files.every((file) =>
        isFinishedAgentTrajectory(trajectoryDir, file, seat.agentId),
      )
    );
  });
  report.trajectoryManifest = {
    directory: path.relative(runDir, trajectoryDir),
    filesByAgent,
  };
  report.assertions.push({
    name: "trajectory-capture-per-runtime",
    passed: trajectoryCapturePassed,
    detail: trajectoryCapturePassed
      ? "every runtime emitted finished, agent-bound model trajectories for every human turn"
      : "one or more runtimes had missing, malformed, unfinished, or misbound trajectory evidence",
  });
  report.passed = report.assertions.every((assertion) => assertion.passed);
  writeJsonAtomically(outputPath, report);
  process.stdout.write(
    `${report.passed ? "PASS" : "FAIL"} multi-agent arena ${report.runId}\n`,
  );
  for (const assertion of report.assertions) {
    process.stdout.write(
      `${assertion.passed ? "✓" : "✗"} ${assertion.name}: ${assertion.detail}\n`,
    );
  }
  process.stdout.write(`report: ${outputPath}\n`);
  if (!report.passed) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  const rawOutputPath = process.argv
    .slice(2)
    .find((arg) => arg.startsWith("--output="))
    ?.slice(9)
    .trim();
  const outputPath = rawOutputPath ? path.resolve(rawOutputPath) : null;
  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    writeJsonAtomically(outputPath, {
      schemaVersion: 1,
      passed: false,
      completedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    });
  }
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
