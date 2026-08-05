/** Pins the scheduled monetization lane to the keyless cloud mock stack. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const workflowText = readFileSync(
  new URL(
    "../../../.github/workflows/monetized-loop-nightly.yml",
    import.meta.url,
  ),
  "utf8",
);

describe("monetized-loop nightly workflow", () => {
  test("runs the complete monetization lifecycle without external credentials", () => {
    expect(workflowText).toContain("monetized-full-loop.spec.ts");
    expect(workflowText).toContain("monetized-mock-llm-journey.spec.ts");
    expect(workflowText).toContain('MOCK_REDIS: "1"');
    expect(workflowText).toContain("DATABASE_URL: pglite://");
    expect(workflowText).not.toContain("secrets.");
    expect(workflowText).not.toContain("HCLOUD_TOKEN_CI");
    expect(workflowText).not.toContain("CLOUD_E2E_API_KEY");
  });

  test("keeps one bounded scheduled and manually dispatchable authority", () => {
    expect(workflowText).toContain('cron: "30 7 * * *"');
    expect(workflowText).toContain("workflow_dispatch:");
    expect(workflowText).toContain("group: monetized-loop-nightly");
    expect(workflowText).toContain("timeout-minutes: 30");
    expect(workflowText.match(/^jobs:/gm)).toHaveLength(1);
    expect(workflowText.match(/^  monetized-loop:/gm)).toHaveLength(1);
  });
});
