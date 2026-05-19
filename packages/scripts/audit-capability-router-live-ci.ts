import { readFileSync } from "node:fs";

const workflowPath = ".github/workflows/test.yml";

type Check = {
  name: string;
  pattern: RegExp;
  message: string;
};

export type LiveCiAuditFailure = {
  workflowPath: string;
  name: string;
  message: string;
};

export const checks: Check[] = [
  {
    name: "cloud live job is required by test-status",
    pattern: /needs:\s*[\s\S]*-\s*cloud-live-e2e[\s\S]*-\s*provider-live-e2e/,
    message: "test-status must depend on cloud-live-e2e and provider-live-e2e.",
  },
  {
    name: "live CI audit self-test is a CI gate",
    pattern:
      /Remote capability live CI audit self-test[\s\S]*test:remote-capabilities:live-ci-audit:self-test/,
    message: "server CI must run the live CI audit self-test.",
  },
  {
    name: "provider live job is required by test-status",
    pattern: /for pair in\s*\\[\s\S]*"cloud-live-e2e:\$\{\{\s*needs\.cloud-live-e2e\.result\s*\}\}"\s*\\[\s\S]*"provider-live-e2e:\$\{\{\s*needs\.provider-live-e2e\.result\s*\}\}"/,
    message:
      "test-status must fail when cloud-live-e2e or provider-live-e2e are not successful in strict events.",
  },
  {
    name: "cloud live smoke is observed only on manual or scheduled runs",
    pattern:
      /Remote capability cloud sandbox live smoke[\s\S]*github\.event_name == 'workflow_dispatch' \|\| github\.event_name == 'schedule'[\s\S]*test:remote-capabilities:cloud-live/,
    message:
      "cloud live smoke must run on workflow_dispatch or schedule events.",
  },
  {
    name: "cloud live report validation is strict",
    pattern:
      /test:remote-capabilities:validate-live-reports --kind cloud --expect-count 1 --max-age-minutes 90 --max-future-minutes 5 --require-ci --require-file-identity --match-github-env reports\/remote-capabilities\/cloud/,
    message:
      "cloud live validation must require count, freshness, CI identity, file identity, and GitHub env matching.",
  },
  {
    name: "cloud live smoke writes reports to the validated directory",
    pattern:
      /Remote capability cloud sandbox live smoke[\s\S]*ELIZA_REMOTE_CAPABILITY_LIVE_REPORT_DIR: reports\/remote-capabilities\/cloud\s*\n[\s\S]*Validate remote capability cloud live report[\s\S]*reports\/remote-capabilities\/cloud/,
    message:
      "cloud live smoke must write reports to the same directory that validation consumes.",
  },
  {
    name: "provider live smoke requires the three primary endpoint secrets",
    pattern:
      /missing_required=\(\)[\s\S]*missing_required\+=\("ELIZA_REMOTE_CAPABILITY_E2B_URL"\)[\s\S]*missing_required\+=\("ELIZA_REMOTE_CAPABILITY_HOME_MACHINE_URL"\)[\s\S]*missing_required\+=\("ELIZA_REMOTE_CAPABILITY_MOBILE_COMPANION_URL"\)/,
    message:
      "provider live smoke must require E2B, home-machine, and mobile-companion endpoints for observed runs.",
  },
  {
    name: "provider live smoke is observed only on manual or scheduled runs",
    pattern:
      /Remote capability URL-backed provider live smoke[\s\S]*github\.event_name == 'workflow_dispatch' \|\| github\.event_name == 'schedule'[\s\S]*test:remote-capabilities:provider-live/,
    message:
      "provider live smoke must run on workflow_dispatch or schedule events.",
  },
  {
    name: "provider live report validation requires all primary providers",
    pattern:
      /test:remote-capabilities:validate-live-reports --kind provider --expect-count 3\.\.4 --max-age-minutes 90 --max-future-minutes 5 --allowed-providers e2b,home-machine,mobile-companion,desktop-companion --require-providers e2b,home-machine,mobile-companion --require-ci --require-file-identity --match-github-env reports\/remote-capabilities\/providers/,
    message:
      "provider live validation must require E2B, home-machine, mobile-companion, freshness, CI identity, file identity, and GitHub env matching.",
  },
  {
    name: "provider live smoke writes reports to the validated directory",
    pattern:
      /Remote capability URL-backed provider live smoke[\s\S]*ELIZA_REMOTE_CAPABILITY_LIVE_REPORT_DIR: reports\/remote-capabilities\/providers\s*\n[\s\S]*Validate remote capability provider live reports[\s\S]*reports\/remote-capabilities\/providers/,
    message:
      "provider live smoke must write reports to the same directory that validation consumes.",
  },
  {
    name: "cloud live reports are uploaded as required artifacts",
    pattern:
      /remote-capability-cloud-live-report[\s\S]*path: reports\/remote-capabilities\/cloud\/\*\.json[\s\S]*if-no-files-found: error/,
    message: "cloud live report artifact upload must fail when reports are absent.",
  },
  {
    name: "provider live reports are uploaded as required artifacts",
    pattern:
      /remote-capability-provider-live-report[\s\S]*path: reports\/remote-capabilities\/providers\/\*\.json[\s\S]*if-no-files-found: error/,
    message:
      "provider live report artifact upload must fail when reports are absent.",
  },
];

export function validateCapabilityRouterLiveCi(
  workflow: string,
  options: { workflowPath?: string } = {},
): LiveCiAuditFailure[] {
  const path = options.workflowPath ?? workflowPath;
  return checks
    .filter((check) => !check.pattern.test(workflow))
    .map((check) => ({
      workflowPath: path,
      name: check.name,
      message: check.message,
    }));
}

if (import.meta.main) {
  const workflow = readFileSync(workflowPath, "utf8");
  const failures = validateCapabilityRouterLiveCi(workflow, { workflowPath });

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(
        `${failure.workflowPath}: ${failure.name}: ${failure.message}`,
      );
    }
    process.exit(1);
  }

  console.log(
    `Capability-router live CI audit passed (${checks.length} checks).`,
  );
}
