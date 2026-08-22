/**
 * Exercises the compliance inventory against real repository descriptors and
 * adversarial registry mutations; no deployment or operator state is mocked.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  discoverComplianceDeploymentDescriptors,
  isComplianceDeploymentDescriptor,
  parseComplianceInventoryArgs,
  renderComplianceInventoryMarkdown,
  runComplianceInventoryAudit,
  validateComplianceInventory,
} from "../compliance-asset-inventory.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "..", "..", "..");
const INVENTORY_FILE = path.join(
  REPO_ROOT,
  ".github",
  "compliance",
  "asset-inventory.json",
);

function rawInventory() {
  return JSON.parse(readFileSync(INVENTORY_FILE, "utf8"));
}

function evidence(pathname: string, claim: string, contains: string[]) {
  return { path: pathname, claim, contains };
}

describe("compliance asset inventory", () => {
  test("classifies every tracked deployment descriptor exactly once", () => {
    const report = runComplianceInventoryAudit({ repoRoot: REPO_ROOT });

    expect(report.coverage.discovered).toBeGreaterThan(100);
    expect(report.coverage.registered).toBe(report.coverage.discovered);
    expect(report.assets.map((asset) => asset.id)).toEqual([
      "cloudflare-edge",
      "container-workloads",
      "cloud-infrastructure",
      "android-clients",
      "apple-clients",
    ]);
    expect(report.assets.flatMap((asset) => asset.sources)).toEqual(
      expect.arrayContaining([
        "packages/homepage/wrangler-aasa.toml",
        "packages/cloud/services/embeddings/railway.toml",
        "packages/cloud/services/gateway-discord/docker-compose.yml",
        "packages/cloud/infra/cloud/terraform/gcp/01-foundation/main.tf",
      ]),
    );
    expect(report.holds.length).toBeGreaterThan(40);
  });

  test("recognizes deployment descriptors without sweeping unrelated manifests", () => {
    expect(
      isComplianceDeploymentDescriptor("packages/cloud/api/wrangler.toml"),
    ).toBe(true);
    expect(
      isComplianceDeploymentDescriptor("packages/homepage/wrangler-aasa.toml"),
    ).toBe(true);
    expect(
      isComplianceDeploymentDescriptor("packages/service/railway.toml"),
    ).toBe(true);
    expect(
      isComplianceDeploymentDescriptor("packages/service/docker-compose.yml"),
    ).toBe(true);
    expect(
      isComplianceDeploymentDescriptor("infra/terraform/root/main.tf"),
    ).toBe(true);
    expect(
      isComplianceDeploymentDescriptor("services/api/Dockerfile.production"),
    ).toBe(true);
    expect(
      isComplianceDeploymentDescriptor(
        "plugins/x/android/src/main/AndroidManifest.xml",
      ),
    ).toBe(true);
    expect(
      isComplianceDeploymentDescriptor(
        "packages/app-core/platforms/ios/App/App/Extension/Info.plist",
      ),
    ).toBe(true);
    expect(
      isComplianceDeploymentDescriptor("packages/example/package.json"),
    ).toBe(false);
    expect(
      isComplianceDeploymentDescriptor("infra/terraform/root/prod.tfvars"),
    ).toBe(false);
    expect(
      isComplianceDeploymentDescriptor("artifacts/Framework/Info.plist"),
    ).toBe(false);
  });

  test("fails when a new deployment descriptor has not been classified", () => {
    const discovered = discoverComplianceDeploymentDescriptors(REPO_ROOT);
    expect(() =>
      validateComplianceInventory(rawInventory(), {
        repoRoot: REPO_ROOT,
        discovered: [
          ...discovered,
          "packages/cloud/services/new/Dockerfile",
        ].sort(),
      }),
    ).toThrow("unclassified deployment descriptors");
  });

  test("fails on duplicate descriptor ownership and stale registrations", () => {
    const duplicate = rawInventory();
    duplicate.assets[1].sources.push(duplicate.assets[0].sources[0]);
    expect(() =>
      validateComplianceInventory(duplicate, {
        repoRoot: REPO_ROOT,
        discovered: discoverComplianceDeploymentDescriptors(REPO_ROOT),
      }),
    ).toThrow("belongs to both");

    const stale = rawInventory();
    const removed = stale.assets[0].sources.pop();
    expect(typeof removed).toBe("string");
    expect(() =>
      validateComplianceInventory(stale, {
        repoRoot: REPO_ROOT,
        discovered: discoverComplianceDeploymentDescriptors(REPO_ROOT),
      }),
    ).toThrow("unclassified deployment descriptors");
  });

  test("requires explicit holds for unknown facts and known asset endpoints for flows", () => {
    const missingHold = rawInventory();
    delete missingHold.assets[0].facts.owner.hold;
    expect(() =>
      validateComplianceInventory(missingHold, {
        repoRoot: REPO_ROOT,
        discovered: discoverComplianceDeploymentDescriptors(REPO_ROOT),
      }),
    ).toThrow("asset cloudflare-edge.facts.owner.hold");

    const badFlow = rawInventory();
    badFlow.flows[0].destination = "shadow-system";
    expect(() =>
      validateComplianceInventory(badFlow, {
        repoRoot: REPO_ROOT,
        discovered: discoverComplianceDeploymentDescriptors(REPO_ROOT),
      }),
    ).toThrow("references an unknown asset");

    const typo = rawInventory();
    typo.assets[0].facts.retentionn = typo.assets[0].facts.retention;
    expect(() =>
      validateComplianceInventory(typo, {
        repoRoot: REPO_ROOT,
        discovered: discoverComplianceDeploymentDescriptors(REPO_ROOT),
      }),
    ).toThrow("unsupported fields: retentionn");
  });

  test("requires tracked evidence for source-verified facts", () => {
    const discovered = discoverComplianceDeploymentDescriptors(REPO_ROOT);

    const factWithoutEvidence = rawInventory();
    factWithoutEvidence.assets[0].facts.lifecycle.evidence = [];
    expect(() =>
      validateComplianceInventory(factWithoutEvidence, {
        repoRoot: REPO_ROOT,
        discovered,
      }),
    ).toThrow(
      "asset cloudflare-edge.facts.lifecycle.evidence must be a non-empty array",
    );

    const factWithBogusEvidence = rawInventory();
    factWithBogusEvidence.assets[0].facts.lifecycle.evidence = [
      evidence("package.json", "repository-tracked", ['"name"']),
    ];
    expect(() =>
      validateComplianceInventory(factWithBogusEvidence, {
        repoRoot: REPO_ROOT,
        discovered,
      }),
    ).toThrow("is not an allowed asset source: package.json");

    const relabeledFact = rawInventory();
    relabeledFact.assets[0].facts.provider.values = [
      "fabricated-provider-certification",
    ];
    relabeledFact.assets[0].facts.provider.evidence[0].claim =
      "fabricated-provider-certification";
    expect(() =>
      validateComplianceInventory(relabeledFact, {
        repoRoot: REPO_ROOT,
        discovered,
      }),
    ).toThrow(
      "source does not identify claim fabricated-provider-certification",
    );

    const absentSourceAssertion = rawInventory();
    absentSourceAssertion.assets[0].facts.provider.evidence[0].contains = [
      "fabricated provider receipt",
    ];
    expect(() =>
      validateComplianceInventory(absentSourceAssertion, {
        repoRoot: REPO_ROOT,
        discovered,
      }),
    ).toThrow("is not present in packages/cloud/api/wrangler.toml");
  });

  test("requires explicit tracked evidence for source-verified flows", () => {
    const discovered = discoverComplianceDeploymentDescriptors(REPO_ROOT);

    const flowWithoutEvidence = rawInventory();
    flowWithoutEvidence.flows[0].status = "source-verified";
    flowWithoutEvidence.flows[0].evidence = [];
    delete flowWithoutEvidence.flows[0].hold;
    expect(() =>
      validateComplianceInventory(flowWithoutEvidence, {
        repoRoot: REPO_ROOT,
        discovered,
      }),
    ).toThrow("flow native-to-edge.evidence must be a non-empty array");

    const flowWithoutEvidenceField = rawInventory();
    delete flowWithoutEvidenceField.flows[0].evidence;
    expect(() =>
      validateComplianceInventory(flowWithoutEvidenceField, {
        repoRoot: REPO_ROOT,
        discovered,
      }),
    ).toThrow("flow native-to-edge.evidence must be an array");

    const flowWithUnscopedEvidence = rawInventory();
    flowWithUnscopedEvidence.flows[0].status = "source-verified";
    flowWithUnscopedEvidence.flows[0].evidence = [
      evidence("package.json", "android-clients", ['"name"']),
    ];
    delete flowWithUnscopedEvidence.flows[0].hold;
    expect(() =>
      validateComplianceInventory(flowWithUnscopedEvidence, {
        repoRoot: REPO_ROOT,
        discovered,
      }),
    ).toThrow("is not an allowed asset source: package.json");

    const relabeledFlow = rawInventory();
    relabeledFlow.flows[0].status = "source-verified";
    relabeledFlow.flows[0].dataClasses = ["certified-health-data"];
    relabeledFlow.flows[0].evidence = [
      evidence(
        "packages/app-core/platforms/android/app/src/main/AndroidManifest.xml",
        "android-clients",
        [
          '<manifest xmlns:android="http://schemas.android.com/apk/res/android">',
        ],
      ),
      evidence("packages/cloud/api/wrangler.toml", "cloudflare-edge", [
        "# eliza-cloud-api — Cloudflare Worker config",
      ]),
      evidence(
        "packages/app-core/platforms/android/app/src/main/AndroidManifest.xml",
        "certified-health-data",
        ['android:name="android.permission.INTERNET"'],
      ),
    ];
    delete relabeledFlow.flows[0].hold;
    expect(() =>
      validateComplianceInventory(relabeledFlow, {
        repoRoot: REPO_ROOT,
        discovered,
      }),
    ).toThrow("source does not identify claim certified-health-data");
  });

  test("requires tracked evidence for source-verified controls", () => {
    const discovered = discoverComplianceDeploymentDescriptors(REPO_ROOT);

    const controlWithoutEvidence = rawInventory();
    controlWithoutEvidence.controls[0].status = "source-verified";
    controlWithoutEvidence.controls[0].evidence = [];
    delete controlWithoutEvidence.controls[0].hold;
    expect(() =>
      validateComplianceInventory(controlWithoutEvidence, {
        repoRoot: REPO_ROOT,
        discovered,
      }),
    ).toThrow("control HIPAA-164.308.evidence must be a non-empty array");

    const controlWithBogusEvidence = rawInventory();
    controlWithBogusEvidence.controls[0].status = "source-verified";
    controlWithBogusEvidence.controls[0].evidence = [
      evidence("package.json", "HIPAA-164.308", ['"name"']),
    ];
    delete controlWithBogusEvidence.controls[0].hold;
    expect(() =>
      validateComplianceInventory(controlWithBogusEvidence, {
        repoRoot: REPO_ROOT,
        discovered,
      }),
    ).toThrow("is not an allowed asset source: package.json");

    const relabeledControl = rawInventory();
    relabeledControl.controls[0] = {
      id: "cloudflare",
      framework: "wrangler",
      owner: "certified-compliance-operator",
      status: "source-verified",
      evidence: [
        evidence("packages/cloud/api/wrangler.toml", "cloudflare", [
          "# eliza-cloud-api — Cloudflare Worker config",
        ]),
        evidence("packages/cloud/api/wrangler.toml", "wrangler", [
          "# eliza-cloud-api — Cloudflare Worker config",
        ]),
        evidence(
          "packages/cloud/api/wrangler.toml",
          "certified-compliance-operator",
          ['name = "eliza-cloud-api"'],
        ),
      ],
    };
    expect(() =>
      validateComplianceInventory(relabeledControl, {
        repoRoot: REPO_ROOT,
        discovered,
      }),
    ).toThrow("source does not identify claim certified-compliance-operator");
  });

  test("rejects protected holds on non-operator facts, flows, and controls", () => {
    const factWithHold = rawInventory();
    factWithHold.assets[0].facts.lifecycle.hold = "not allowed";
    expect(() =>
      validateComplianceInventory(factWithHold, {
        repoRoot: REPO_ROOT,
        discovered: discoverComplianceDeploymentDescriptors(REPO_ROOT),
      }),
    ).toThrow(
      "asset cloudflare-edge.facts.lifecycle.hold is allowed only for operator-review-required facts",
    );

    const flowWithHold = rawInventory();
    flowWithHold.flows[0].status = "policy";
    expect(() =>
      validateComplianceInventory(flowWithHold, {
        repoRoot: REPO_ROOT,
        discovered: discoverComplianceDeploymentDescriptors(REPO_ROOT),
      }),
    ).toThrow(
      "flow native-to-edge.hold is allowed only for operator-review-required flows",
    );

    const policyWithHold = rawInventory();
    policyWithHold.controls[0].status = "policy";
    expect(() =>
      validateComplianceInventory(policyWithHold, {
        repoRoot: REPO_ROOT,
        discovered: discoverComplianceDeploymentDescriptors(REPO_ROOT),
      }),
    ).toThrow(
      "control HIPAA-164.308.hold is allowed only for operator-review-required controls",
    );
  });

  test("derives the human network, control, and protected-hold view from the registry", () => {
    const markdown = renderComplianceInventoryMarkdown(
      runComplianceInventoryAudit({ repoRoot: REPO_ROOT }),
    );

    expect(markdown).toContain("flowchart LR");
    expect(markdown).toContain(
      "android_clients -->|account-data, credentials, user-content| cloudflare_edge",
    );
    expect(markdown).toContain("HIPAA-164.312");
    expect(markdown).toContain("| native-to-edge | operator-review-required |");
    expect(markdown).toContain("Protected acceptance holds");
  });

  test("rejects ambiguous CLI arguments and confines reports to the reports tree", () => {
    expect(parseComplianceInventoryArgs(["--strict", "--json"])).toMatchObject({
      strict: true,
      json: true,
    });
    expect(() =>
      parseComplianceInventoryArgs(["--strict", "--strict"]),
    ).toThrow("only once");
    expect(() =>
      parseComplianceInventoryArgs(["--report", "../inventory.json"]),
    ).toThrow("traversal");
    expect(() => parseComplianceInventoryArgs(["--unknown"])).toThrow(
      "unknown argument",
    );
  });
});
