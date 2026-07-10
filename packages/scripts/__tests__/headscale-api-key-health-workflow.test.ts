/**
 * Static contract for the scheduled Headscale credential probe. The monitor
 * must fail loud on expired host-local credentials without importing the
 * Headscale admin key into the GitHub Actions runner.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const workflowText = readFileSync(
  new URL(
    "../../../.github/workflows/headscale-api-key-health.yml",
    import.meta.url,
  ),
  "utf8",
);

function extractStepBody(stepName: string): string {
  const escapedName = stepName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = workflowText.match(
    new RegExp(
      `^      - name: ${escapedName}\\n(?<body>[\\s\\S]*?)(?=^      - (?:name|uses|id): |$(?![\\s\\S]))`,
      "m",
    ),
  );
  if (!match?.groups?.body) {
    throw new Error(`Missing workflow step: ${stepName}`);
  }
  return match.groups.body;
}

function extractRemoteScript(stepName: string): string {
  const script = extractStepBody(stepName).match(
    /^ {10}script: \|\n(?<body>(?: {12}.*(?:\n|$))*)/m,
  )?.groups?.body;
  if (!script) {
    throw new Error(`Workflow step has no remote script: ${stepName}`);
  }
  return script
    .split("\n")
    .map((line) => line.replace(/^ {12}/, ""))
    .join("\n");
}

describe("Headscale API key health workflow", () => {
  test("runs staging on a daily cadence and keeps production manually selectable", () => {
    expect(workflowText).toContain('cron: "23 7 * * *"');
    expect(workflowText).toContain("options: [staging, production]");
    expect(workflowText).toContain(
      `environment: \${{ github.event.inputs.environment || "staging" }}`.replace(
        '"staging"',
        "'staging'",
      ),
    );
  });

  test("keeps the Headscale admin key on the control-plane host", () => {
    const envBlock = workflowText.match(
      / {4}env:\n(?<body>(?: {6}.*\n)+) {4}steps:/,
    )?.groups?.body;

    expect(envBlock).toBeDefined();
    expect(envBlock).not.toContain("HEADSCALE_API_KEY");
    expect(workflowText).not.toContain("secrets.HEADSCALE_API_KEY");

    const probe = extractStepBody("Probe daemon-local Headscale API");
    expect(probe).toContain("ENV_FILE=/opt/eliza/cloud/.env.local");
    expect(probe).toContain(
      "HEADSCALE_API_KEY=$(read_env_value HEADSCALE_API_KEY)",
    );
  });

  test("fails loud for missing, rejected, unreachable, and malformed credentials", () => {
    const probe = extractStepBody("Probe daemon-local Headscale API");

    expect(probe).toContain("HEADSCALE_API_KEY is missing");
    expect(probe).toContain("401|403)");
    expect(probe).toContain("Headscale API probe could not reach");
    expect(probe).toContain("HTTP 200 with an invalid user-list payload");
    expect(probe).toContain("exit 1");
  });

  test("keeps the remote probe valid Bash", () => {
    const result = spawnSync("bash", ["-n"], {
      encoding: "utf8",
      input: extractRemoteScript("Probe daemon-local Headscale API"),
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });
});
