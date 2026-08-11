/**
 * Guards the fork pull-request CI boundary: outside code stays on disposable
 * runners, receives every distinct validation surface, and does not pay for
 * checks already supplied by canonical CI.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dir, "../../..");
const workflow = (name: string): string =>
  readFileSync(join(repositoryRoot, ".github/workflows", name), "utf8");

const forkSkip = "github.event.pull_request.head.repo.fork == false";

describe("fork pull-request workflow policy", () => {
  test("canonical CI is entirely GitHub-hosted and read-only", () => {
    const canonical = workflow("ci.yml");

    expect(canonical).toContain("permissions:\n  contents: read");
    expect(canonical).not.toContain("self-hosted");
    expect(
      canonical.match(/runs-on: ubuntu-24\.04/g)?.length,
    ).toBeGreaterThanOrEqual(7);
  });

  test("duplicate develop PR jobs skip forks", () => {
    const developPr = workflow("develop-pr.yml");

    expect(
      developPr.match(new RegExp(forkSkip.replaceAll(".", "\\."), "g"))?.length,
    ).toBe(4);
  });

  test("standalone gitleaks skips forks while preserving push coverage", () => {
    const gitleaks = workflow("gitleaks.yml");

    expect(gitleaks).toContain(
      `if: github.event_name != 'pull_request' || ${forkSkip}`,
    );
    expect(gitleaks).toContain('push:\n    branches: ["main", "develop"]');
  });

  test("distinct fork checks remain available", () => {
    for (const name of [
      "cloud-tests.yml",
      "pr.yaml",
      "ui-e2e-gate.yml",
      "ui-fixture-e2e.yml",
    ]) {
      const contents = workflow(name);
      expect(contents).toContain("pull_request:");
      expect(contents).not.toContain(forkSkip);
    }
  });

  test("fork-capable optional fleet jobs fail safe to hosted runners", () => {
    for (const name of ["cloud-tests.yml", "gitleaks.yml", "ui-e2e-gate.yml"]) {
      const contents = workflow(name);
      expect(contents).toContain("vars.HETZNER_FLEET_ONLINE != 'true'");
      expect(contents).not.toContain("vars.HETZNER_FLEET_ONLINE == 'false'");
    }
  });
});
