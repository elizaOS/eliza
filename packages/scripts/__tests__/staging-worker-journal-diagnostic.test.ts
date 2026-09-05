/** Exercises the hosted journal classifier with private log records and invalid input. */
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const workflow = Bun.YAML.parse(
  readFileSync(
    new URL("../../../.github/workflows/live-smoke.yml", import.meta.url),
    "utf8",
  ),
) as {
  jobs: Record<
    string,
    { steps: { name?: string; with?: { script?: string } }[] }
  >;
};
const script = workflow.jobs["dedicated-diagnostic"].steps.find(
  (step) => step.name === "Classify recent provisioning worker failures",
)?.with?.script;
if (!script) throw new Error("Missing hosted journal classifier");
const python = script.split("python3 -c '\n")[1]?.replace(/'\s*$/, "");
if (!python) throw new Error("Missing executable Python classifier");

function classify(input: string) {
  return spawnSync("python3", ["-c", python], { input, encoding: "utf8" });
}

test("identifies timeout phase without emitting private journal content", () => {
  const messages = [
    "[docker-sandbox] Image pulled successfully on private-node.example",
    "Sandbox creation failed: [docker-ssh] Command timed out after 60000ms: PRIVATE_CREDENTIAL\n    at DockerSSHClient.exec (/private/path.ts:1:2)",
    "Sandbox health check timed out\n    at ElizaSandboxService.provision (/private/other.ts:9:1)",
    "user prompt: PRIVATE_USER_TEXT",
  ];
  const result = classify(
    messages
      .map((MESSAGE) => JSON.stringify({ MESSAGE, _HOSTNAME: "private-host" }))
      .join("\n"),
  );
  expect(result.status).toBe(0);
  const report = JSON.parse(result.stdout);
  expect(report.signals.sandbox_creation_timeout).toBe(1);
  expect(report.signals.sandbox_health_timeout).toBe(1);
  expect(report.signals.ssh_command_timeout).toBe(1);
  expect(report.timeoutDurationsMs["60000"]).toBe(1);
  expect(report.timeoutFunctions).toEqual({ exec: 1, provision: 1 });
  expect(result.stdout).not.toMatch(
    /PRIVATE|private[-/.]|credential|user prompt/i,
  );
});

test("distinguishes empty journal from an unreadable journal", () => {
  const empty = classify("");
  expect(empty.status).toBe(0);
  expect(JSON.parse(empty.stdout)).toMatchObject({ records: 0, signals: {} });
  for (const input of [
    "invalid json",
    JSON.stringify({ MESSAGE: ["PRIVATE_TEXT"] }),
  ]) {
    const invalid = classify(input);
    expect(invalid.status).not.toBe(0);
    expect(invalid.stdout).toBe("");
    expect(invalid.stderr).not.toContain("PRIVATE_TEXT");
  }
});
