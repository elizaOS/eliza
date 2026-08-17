/**
 * Regression test for Cloud CF release temporary checkout authentication.
 *
 * GitHub Smart HTTP authentication requires Basic auth with base64(x-access-token:<token>)
 * rather than Bearer auth, while keeping the token out of persistent git config / remote URLs.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const workflowPath = join(
  import.meta.dir,
  "../../../.github/workflows/cloud-cf-release.yml",
);
const workflow = parse(readFileSync(workflowPath, "utf8"));

function steps(jobName: string): Array<{
  name?: string;
  id?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
}> {
  return workflow.jobs[jobName].steps;
}

function step(jobName: string, name: string) {
  const found = steps(jobName).find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing ${jobName} step: ${name}`);
  return found;
}

describe("Cloud CF release temporary checkout authentication", () => {
  it("authenticates git fetch in deploy-api with ephemeral Basic header", () => {
    const checkoutStep = step("deploy-api", "Checkout repository");
    expect(checkoutStep.run).toBeDefined();
    expect(checkoutStep.run).toContain("auth_header=");
    expect(checkoutStep.run).toContain("AUTHORIZATION: basic");
    expect(checkoutStep.run).toContain("x-access-token:");
    expect(checkoutStep.run).toContain("base64");
    expect(checkoutStep.run).not.toContain("AUTHORIZATION: bearer");
    expect(checkoutStep.env?.CHECKOUT_TOKEN).toContain("github.token");
  });

  it("authenticates git fetch in deploy-app with ephemeral Basic header", () => {
    const checkoutStep = step("deploy-app", "Checkout repository");
    expect(checkoutStep.run).toBeDefined();
    expect(checkoutStep.run).toContain("auth_header=");
    expect(checkoutStep.run).toContain("AUTHORIZATION: basic");
    expect(checkoutStep.run).toContain("x-access-token:");
    expect(checkoutStep.run).toContain("base64");
    expect(checkoutStep.run).not.toContain("AUTHORIZATION: bearer");
    expect(checkoutStep.env?.CHECKOUT_TOKEN).toContain("github.token");
  });
});
