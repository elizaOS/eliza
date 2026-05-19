import { readFileSync } from "node:fs";
import {
  checks,
  validateCapabilityRouterLiveCi,
} from "./audit-capability-router-live-ci.ts";

const workflowPath = ".github/workflows/test.yml";
const workflow = readFileSync(workflowPath, "utf8");
const rootPackageJson = readFileSync("package.json", "utf8");
const agentPackageJson = readFileSync("packages/agent/package.json", "utf8");
const providerSmokeSource = readFileSync(
  "packages/agent/src/services/remote-capability-url-endpoint-providers.provider-smoke.test.ts",
  "utf8",
);

assertPasses("current workflow", workflow);

assertFails(
  "live CI audit self-test is a CI gate",
  workflow.replace(
    "      - name: Remote capability live CI audit self-test\n        run: bun run test:remote-capabilities:live-ci-audit:self-test\n\n",
    "",
  ),
);

assertFails(
  "live report validator self-test is a CI gate",
  workflow.replace(
    "      - name: Remote capability live report validator self-test\n        run: bun run test:remote-capabilities:validate-live-reports:self-test\n\n",
    "",
  ),
);

const rootPackageFailure = assertFails(
  "live report validator self-test script exists",
  workflow,
  rootPackageJson.replace(
    '    "test:remote-capabilities:validate-live-reports:self-test": "bun packages/scripts/validate-capability-router-live-reports.self-test.ts",\n',
    "",
  ),
);
if (rootPackageFailure.sourcePath !== "package.json") {
  throw new Error(
    `root package failure reported wrong source path: ${rootPackageFailure.sourcePath}`,
  );
}

assertRootPackageFailure(
  "live report validator script exists",
  rootPackageJson.replace(
    '    "test:remote-capabilities:validate-live-reports": "bun packages/scripts/validate-capability-router-live-reports.ts",\n',
    "",
  ),
);

assertRootPackageFailure(
  "live CI audit script exists",
  rootPackageJson.replace(
    '    "test:remote-capabilities:live-ci-audit": "bun packages/scripts/audit-capability-router-live-ci.ts",\n',
    "",
  ),
);

assertRootPackageFailure(
  "live CI audit self-test script exists",
  rootPackageJson.replace(
    '    "test:remote-capabilities:live-ci-audit:self-test": "bun packages/scripts/audit-capability-router-live-ci.self-test.ts",\n',
    "",
  ),
);

const packageFailure = assertFails(
  "canonical remote capability suite covers live report writer",
  workflow,
  rootPackageJson,
  agentPackageJson.replace(
    " packages/agent/src/services/remote-capability-live-report.test.ts",
    "",
  ),
);
if (packageFailure.sourcePath !== "packages/agent/package.json") {
  throw new Error(
    `package-level failure reported wrong source path: ${packageFailure.sourcePath}`,
  );
}

assertFails(
  "canonical remote capability suite covers live report writer",
  `${workflow}\n# packages/agent/src/services/remote-capability-live-report.test.ts`,
  rootPackageJson,
  agentPackageJson.replace(
    " packages/agent/src/services/remote-capability-live-report.test.ts",
    "",
  ),
);

assertFails(
  "cloud live job is required by test-status",
  workflow.replace("      - cloud-live-e2e\n", ""),
);

assertFails(
  "provider live job is required by test-status",
  workflow.replace(
    '            "provider-live-e2e:${{ needs.provider-live-e2e.result }}"',
    "",
  ),
);

assertFails(
  "provider live job is required by test-status",
  workflow.replace(
    "strict_results=\"${{ github.event_name == 'push' || github.event_name == 'workflow_dispatch' || github.event_name == 'schedule' }}\"",
    "strict_results=\"${{ github.event_name == 'push' || github.event_name == 'workflow_dispatch' }}\"",
  ),
);

assertFails(
  "cloud live smoke writes reports to the validated directory",
  workflow.replace(
    "ELIZA_REMOTE_CAPABILITY_LIVE_REPORT_DIR: reports/remote-capabilities/cloud",
    "ELIZA_REMOTE_CAPABILITY_LIVE_REPORT_DIR: reports/remote-capabilities/unvalidated-cloud",
  ),
);

assertFails(
  "cloud live smoke is observed only on manual or scheduled runs",
  workflow.replace(
    "      - name: Remote capability cloud sandbox live smoke\n        if: steps.cloud.outputs.skip != 'true' && (github.event_name == 'workflow_dispatch' || github.event_name == 'schedule')",
    "      - name: Remote capability cloud sandbox live smoke\n        if: steps.cloud.outputs.skip != 'true'",
  ),
);

assertFails(
  "cloud live report validation is strict",
  workflow.replace(
    " --require-ci --require-file-identity --match-github-env reports/remote-capabilities/cloud",
    " --require-file-identity --match-github-env reports/remote-capabilities/cloud",
  ),
);

assertFails(
  "cloud live report validation is strict",
  workflow.replace(
    " --require-file-identity --match-github-env reports/remote-capabilities/cloud",
    " --match-github-env reports/remote-capabilities/cloud",
  ),
);

assertFails(
  "cloud live report validation is strict",
  workflow.replace(
    " --max-age-minutes 90 --max-future-minutes 5",
    " --max-age-minutes 90",
  ),
);

assertFails(
  "provider live smoke writes reports to the validated directory",
  workflow.replace(
    "ELIZA_REMOTE_CAPABILITY_LIVE_REPORT_DIR: reports/remote-capabilities/providers",
    "ELIZA_REMOTE_CAPABILITY_LIVE_REPORT_DIR: reports/remote-capabilities/unvalidated-providers",
  ),
);

const providerSmokeFailure = assertFails(
  "provider live reports include providerId evidence",
  workflow,
  rootPackageJson,
  agentPackageJson,
  providerSmokeSource.replace("          providerId: result.providerId,\n", ""),
);
if (
  providerSmokeFailure.sourcePath !==
  "packages/agent/src/services/remote-capability-url-endpoint-providers.provider-smoke.test.ts"
) {
  throw new Error(
    `provider-smoke failure reported wrong source path: ${providerSmokeFailure.sourcePath}`,
  );
}

assertFails(
  "provider live smoke is observed only on manual or scheduled runs",
  workflow.replace(
    "      - name: Remote capability URL-backed provider live smoke\n        if: steps.providers.outputs.skip != 'true' && (github.event_name == 'workflow_dispatch' || github.event_name == 'schedule')",
    "      - name: Remote capability URL-backed provider live smoke\n        if: steps.providers.outputs.skip != 'true'",
  ),
);

assertFails(
  "provider live smoke requires the three primary endpoint secrets",
  workflow.replace(
    '          if [ -z "${MOBILE_URL}" ]; then\n            missing_required+=("ELIZA_REMOTE_CAPABILITY_MOBILE_COMPANION_URL")\n          fi\n\n',
    "",
  ),
);

assertFails(
  "provider live report validation requires all primary providers",
  workflow.replace(
    " --require-providers e2b,home-machine,mobile-companion --require-ci",
    " --require-providers e2b,home-machine --require-ci",
  ),
);

assertFails(
  "provider live report validation requires all primary providers",
  workflow.replace(
    " --allowed-providers e2b,home-machine,mobile-companion,desktop-companion --require-providers",
    " --allowed-providers e2b,home-machine,mobile-companion,desktop-companion,unreviewed-provider --require-providers",
  ),
);

assertFails(
  "provider live report validation requires all primary providers",
  workflow.replace(
    " --require-ci --require-file-identity --match-github-env reports/remote-capabilities/providers",
    " --require-ci --require-file-identity reports/remote-capabilities/providers",
  ),
);

assertFails(
  "cloud live reports are uploaded as required artifacts",
  workflow.replace(
    "path: reports/remote-capabilities/cloud/*.json",
    "path: reports/remote-capabilities/unuploaded-cloud/*.json",
  ),
);

assertFails(
  "provider live reports are uploaded as required artifacts",
  workflow.replace(
    "path: reports/remote-capabilities/providers/*.json",
    "path: reports/remote-capabilities/unuploaded-providers/*.json",
  ),
);

console.log(
  `Capability-router live CI audit self-test passed (${checks.length} checks).`,
);

function assertPasses(
  name: string,
  candidate: string,
  candidateRootPackageJson = rootPackageJson,
  candidateAgentPackageJson = agentPackageJson,
  candidateProviderSmokeSource = providerSmokeSource,
): void {
  const failures = validateCapabilityRouterLiveCi(candidate, {
    agentPackageJson: candidateAgentPackageJson,
    providerSmokeSource: candidateProviderSmokeSource,
    rootPackageJson: candidateRootPackageJson,
    workflowPath: `${name}.yml`,
  });
  if (failures.length > 0) {
    throw new Error(
      `${name} unexpectedly failed live CI audit: ${failures
        .map((failure) => failure.name)
        .join(", ")}`,
    );
  }
}

function assertFails(
  expectedCheckName: string,
  candidate: string,
  candidateRootPackageJson = rootPackageJson,
  candidateAgentPackageJson = agentPackageJson,
  candidateProviderSmokeSource = providerSmokeSource,
): ReturnType<typeof validateCapabilityRouterLiveCi>[number] {
  const failures = validateCapabilityRouterLiveCi(candidate, {
    agentPackageJson: candidateAgentPackageJson,
    providerSmokeSource: candidateProviderSmokeSource,
    rootPackageJson: candidateRootPackageJson,
    workflowPath: "mutated-workflow.yml",
  });
  const expectedFailure = failures.find(
    (failure) => failure.name === expectedCheckName,
  );
  if (!expectedFailure) {
    throw new Error(
      `mutated workflow did not fail "${expectedCheckName}"; failures: ${failures
        .map((failure) => failure.name)
        .join(", ")}`,
    );
  }
  return expectedFailure;
}

function assertRootPackageFailure(
  expectedCheckName: string,
  candidateRootPackageJson: string,
): void {
  const failure = assertFails(
    expectedCheckName,
    workflow,
    candidateRootPackageJson,
  );
  if (failure.sourcePath !== "package.json") {
    throw new Error(
      `root package failure reported wrong source path: ${failure.sourcePath}`,
    );
  }
}
