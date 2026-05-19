import { readFileSync } from "node:fs";
import {
  checks,
  validateCapabilityRouterLiveCi,
} from "./audit-capability-router-live-ci.ts";

const workflowPath = ".github/workflows/test.yml";
const workflow = readFileSync(workflowPath, "utf8");

assertPasses("current workflow", workflow);

assertFails(
  "live CI audit self-test is a CI gate",
  workflow.replace(
    "      - name: Remote capability live CI audit self-test\n        run: bun run test:remote-capabilities:live-ci-audit:self-test\n\n",
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

function assertPasses(name: string, candidate: string): void {
  const failures = validateCapabilityRouterLiveCi(candidate, {
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

function assertFails(expectedCheckName: string, candidate: string): void {
  const failures = validateCapabilityRouterLiveCi(candidate, {
    workflowPath: "mutated-workflow.yml",
  });
  if (!failures.some((failure) => failure.name === expectedCheckName)) {
    throw new Error(
      `mutated workflow did not fail "${expectedCheckName}"; failures: ${failures
        .map((failure) => failure.name)
        .join(", ")}`,
    );
  }
}
