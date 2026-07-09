/**
 * Static contract for the real-Hetzner monetized loop workflow: missing
 * credentials may be an honest scheduled skip, but rejected configured
 * credentials must fail closed so nightly green cannot hide a dead secret.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const workflowText = readFileSync(
  new URL(
    "../../../.github/workflows/monetized-loop-nightly.yml",
    import.meta.url,
  ),
  "utf8",
);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractStepRunBlock(stepName: string): string {
  const stepPattern = new RegExp(
    `^      - name: ${escapeRegExp(stepName)}\\n(?<body>[\\s\\S]*?)(?=^      - (?:name|uses|id): |$(?![\\s\\S]))`,
    "m",
  );
  const stepMatch = workflowText.match(stepPattern);
  if (!stepMatch?.groups?.body) {
    throw new Error(`Missing workflow step: ${stepName}`);
  }

  const runMatch = stepMatch.groups.body.match(
    /^ {8}run: \|\n(?<run>(?: {10}.*(?:\n|$))*)/m,
  );
  if (!runMatch?.groups?.run) {
    throw new Error(`Workflow step has no shell run block: ${stepName}`);
  }

  return runMatch.groups.run
    .split("\n")
    .map((line) => line.replace(/^ {10}/, ""))
    .join("\n")
    .trim();
}

describe("monetized-loop nightly workflow credential gates", () => {
  test("keeps missing secrets as an honest scheduled skip", () => {
    const runBlock = extractStepRunBlock("Check secret configuration");

    expect(runBlock).toContain("Missing secrets:");
    expect(runBlock).toContain(
      'if [ "$' + '{{ github.event_name }}" = "workflow_dispatch" ]; then',
    );
    expect(runBlock).toContain(
      "Manual dispatch requires HCLOUD_TOKEN_CI + CLOUD_E2E_API_KEY.",
    );
  });

  test("fails closed when the configured Cloud credential is rejected", () => {
    const runBlock = extractStepRunBlock("Cloud API auth preflight");

    expect(runBlock).toContain(
      'if [ "$status_code" = "401" ] || [ "$status_code" = "403" ]; then',
    );
    expect(runBlock).toContain(
      "::error::Cloud API rejected CLOUD_E2E_API_KEY with HTTP $status_code",
    );
    expect(runBlock).toContain("exit 1");
    expect(runBlock).not.toMatch(
      /status_code" = "401"[\s\S]*skipping monetized-loop nightly/,
    );
  });
});
