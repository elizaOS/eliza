import { readFileSync } from "node:fs";

const workflowPath = ".github/workflows/test.yml";
const rootPackagePath = "package.json";
const agentPackagePath = "packages/agent/package.json";
const endpointConformancePath =
  "packages/agent/src/services/remote-capability-endpoint-conformance.ts";
const liveReportWriterPath =
  "packages/agent/src/services/remote-capability-live-report.ts";
const providerSmokePath =
  "packages/agent/src/services/remote-capability-url-endpoint-providers.provider-smoke.test.ts";
const liveReportValidatorPath =
  "packages/scripts/validate-capability-router-live-reports.ts";

type Check = {
  name: string;
  pattern: RegExp;
  source?:
    | "agent-package"
    | "endpoint-conformance"
    | "live-report-validator"
    | "live-report-writer"
    | "provider-smoke"
    | "root-package"
    | "workflow";
  message: string;
};

export type LiveCiAuditFailure = {
  sourcePath: string;
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
    name: "live report validator self-test is a CI gate",
    pattern:
      /Remote capability live report validator self-test[\s\S]*test:remote-capabilities:validate-live-reports:self-test/,
    message: "server CI must run the live report validator self-test.",
  },
  {
    name: "live report validator self-test script exists",
    pattern:
      /"test:remote-capabilities:validate-live-reports:self-test"\s*:\s*"bun packages\/scripts\/validate-capability-router-live-reports\.self-test\.ts"/,
    source: "root-package",
    message:
      "root package scripts must expose the live report validator self-test.",
  },
  {
    name: "live report validator script exists",
    pattern:
      /"test:remote-capabilities:validate-live-reports"\s*:\s*"bun packages\/scripts\/validate-capability-router-live-reports\.ts"/,
    source: "root-package",
    message: "root package scripts must expose the live report validator.",
  },
  {
    name: "live CI audit script exists",
    pattern:
      /"test:remote-capabilities:live-ci-audit"\s*:\s*"bun packages\/scripts\/audit-capability-router-live-ci\.ts"/,
    source: "root-package",
    message: "root package scripts must expose the live CI audit.",
  },
  {
    name: "live CI audit self-test script exists",
    pattern:
      /"test:remote-capabilities:live-ci-audit:self-test"\s*:\s*"bun packages\/scripts\/audit-capability-router-live-ci\.self-test\.ts"/,
    source: "root-package",
    message: "root package scripts must expose the live CI audit self-test.",
  },
  {
    name: "canonical remote capability suite covers live report writer",
    pattern:
      /"test:remote-capabilities"[\s\S]*packages\/agent\/src\/services\/remote-capability-live-report\.test\.ts/,
    source: "agent-package",
    message:
      "test:remote-capabilities must include the live report writer safety test.",
  },
  {
    name: "live report writer records runtime module surface counts",
    pattern:
      /remotePlugins:[\s\S]*\.map\(\(plugin\) => \(\{[\s\S]*pluginName:\s*plugin\.name,[\s\S]*moduleId:\s*plugin\.config\?\.remoteCapabilityModuleId,[\s\S]*endpointId:\s*plugin\.config\?\.remoteCapabilityEndpointId,[\s\S]*\.\.\.summarizeRemoteCapabilityPluginSurfaces\(plugin\),/,
    source: "live-report-writer",
    message:
      "runtime.remotePlugins live summaries must record per-module surface counts.",
  },
  {
    name: "live report validator compares runtime module surface counts",
    pattern:
      /registeredModuleCountsByKey[\s\S]*validateRuntimeRemotePlugins\([\s\S]*registeredModuleCountsByKey[\s\S]*runtime\.remotePlugins\[\$\{index\}\]\.\$\{field\} must match sync\.registeredModules/,
    source: "live-report-validator",
    message:
      "live report validation must compare runtime.remotePlugins counts with sync.registeredModules.",
  },
  {
    name: "endpoint conformance requires non-empty route bodies",
    pattern:
      /function assertRouteResult[\s\S]*hasMeaningfulRouteBody\(result\.body\)[\s\S]*function hasMeaningfulRouteBody[\s\S]*value === undefined \|\| value === null[\s\S]*Array\.isArray\(value\)[\s\S]*Object\.keys\(value\)\.length > 0/,
    source: "endpoint-conformance",
    message:
      "endpoint conformance must reject route calls without non-empty JSON body evidence.",
  },
  {
    name: "live report validator requires non-empty route bodies",
    pattern:
      /routeResult\.body[\s\S]*isMeaningfulJsonEvidence\(routeResult\.body\)[\s\S]*conformance\.routeResult\.body must be a non-empty JSON value[\s\S]*function isMeaningfulJsonEvidence[\s\S]*value === undefined \|\| value === null[\s\S]*Array\.isArray\(value\)[\s\S]*Object\.keys\(value\)\.length > 0/,
    source: "live-report-validator",
    message:
      "live report validation must reject route results without non-empty JSON body evidence.",
  },
  {
    name: "provider live job is required by test-status",
    pattern: /strict_results="\$\{\{\s*github\.event_name == 'push' \|\| github\.event_name == 'workflow_dispatch' \|\| github\.event_name == 'schedule'\s*\}\}"[\s\S]*for pair in\s*\\[\s\S]*"cloud-live-e2e:\$\{\{\s*needs\.cloud-live-e2e\.result\s*\}\}"\s*\\[\s\S]*"provider-live-e2e:\$\{\{\s*needs\.provider-live-e2e\.result\s*\}\}"/,
    message:
      "test-status must fail when cloud-live-e2e or provider-live-e2e are not successful on push, workflow_dispatch, or schedule.",
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
    name: "provider live reports include providerId evidence",
    pattern:
      /writeRemoteCapabilityLiveReport\(target\.label,[\s\S]*provider:\s*target\.label,[\s\S]*providerId:\s*result\.providerId,/,
    source: "provider-smoke",
    message:
      "provider live reports must record the endpoint providerId returned by the provider.",
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
  options: {
    agentPackageJson?: string;
    endpointConformanceSource?: string;
    providerSmokeSource?: string;
    rootPackageJson?: string;
    liveReportValidatorSource?: string;
    liveReportWriterSource?: string;
    workflowPath?: string;
  } = {},
): LiveCiAuditFailure[] {
  const path = options.workflowPath ?? workflowPath;
  return checks
    .filter((check) => {
      const content = getCheckContent(check, workflow, options);
      return !check.pattern.test(content);
    })
    .map((check) => ({
      sourcePath: getCheckSourcePath(check, path),
      workflowPath: path,
      name: check.name,
      message: check.message,
    }));
}

function getCheckContent(
  check: Check,
  workflow: string,
  options: {
    agentPackageJson?: string;
    endpointConformanceSource?: string;
    providerSmokeSource?: string;
    rootPackageJson?: string;
    liveReportValidatorSource?: string;
    liveReportWriterSource?: string;
  },
): string {
  if (check.source === "agent-package") return options.agentPackageJson ?? "";
  if (check.source === "endpoint-conformance") {
    return options.endpointConformanceSource ?? "";
  }
  if (check.source === "live-report-validator") {
    return options.liveReportValidatorSource ?? "";
  }
  if (check.source === "live-report-writer") {
    return options.liveReportWriterSource ?? "";
  }
  if (check.source === "provider-smoke") {
    return options.providerSmokeSource ?? "";
  }
  if (check.source === "root-package") return options.rootPackageJson ?? "";
  return workflow;
}

function getCheckSourcePath(check: Check, workflowPath: string): string {
  if (check.source === "agent-package") return agentPackagePath;
  if (check.source === "endpoint-conformance") return endpointConformancePath;
  if (check.source === "live-report-validator") return liveReportValidatorPath;
  if (check.source === "live-report-writer") return liveReportWriterPath;
  if (check.source === "provider-smoke") return providerSmokePath;
  if (check.source === "root-package") return rootPackagePath;
  return workflowPath;
}

if (import.meta.main) {
  const workflow = readFileSync(workflowPath, "utf8");
  const rootPackageJson = readFileSync(rootPackagePath, "utf8");
  const agentPackageJson = readFileSync(agentPackagePath, "utf8");
  const endpointConformanceSource = readFileSync(
    endpointConformancePath,
    "utf8",
  );
  const liveReportValidatorSource = readFileSync(liveReportValidatorPath, "utf8");
  const liveReportWriterSource = readFileSync(liveReportWriterPath, "utf8");
  const providerSmokeSource = readFileSync(providerSmokePath, "utf8");
  const failures = validateCapabilityRouterLiveCi(workflow, {
    agentPackageJson,
    endpointConformanceSource,
    liveReportValidatorSource,
    liveReportWriterSource,
    providerSmokeSource,
    rootPackageJson,
    workflowPath,
  });

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(
        `${failure.sourcePath}: ${failure.name}: ${failure.message}`,
      );
    }
    process.exit(1);
  }

  console.log(
    `Capability-router live CI audit passed (${checks.length} checks).`,
  );
}
