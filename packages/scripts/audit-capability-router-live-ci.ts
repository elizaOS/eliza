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
const liveReportValidatorSelfTestPath =
  "packages/scripts/validate-capability-router-live-reports.self-test.ts";

type Check = {
  name: string;
  pattern: RegExp;
  source?:
    | "agent-package"
    | "endpoint-conformance"
    | "live-report-validator"
    | "live-report-validator-self-test"
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
    pattern:
      /test-status:\s+name:[\s\S]*?needs:[\s\S]*?-\s*cloud-live-e2e[\s\S]*?-\s*provider-live-e2e/,
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
    name: "GitHub live evidence validator self-test is a CI gate",
    pattern:
      /Remote capability GitHub live evidence self-test[\s\S]*test:remote-capabilities:github-live-evidence:self-test/,
    message:
      "server CI must run the GitHub live evidence validator self-test.",
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
    name: "GitHub live evidence validator script exists",
    pattern:
      /"test:remote-capabilities:github-live-evidence"\s*:\s*"bun packages\/scripts\/validate-capability-router-github-live-evidence\.ts"/,
    source: "root-package",
    message:
      "root package scripts must expose the GitHub live evidence validator.",
  },
  {
    name: "GitHub live artifact validator script exists",
    pattern:
      /"test:remote-capabilities:github-live-artifacts"\s*:\s*"bun packages\/scripts\/validate-capability-router-github-live-artifacts\.ts"/,
    source: "root-package",
    message:
      "root package scripts must expose the GitHub live artifact validator.",
  },
  {
    name: "GitHub live evidence validator self-test script exists",
    pattern:
      /"test:remote-capabilities:github-live-evidence:self-test"\s*:\s*"bun packages\/scripts\/validate-capability-router-github-live-evidence\.self-test\.ts"/,
    source: "root-package",
    message:
      "root package scripts must expose the GitHub live evidence validator self-test.",
  },
  {
    name: "GitHub live artifact validator downloads and validates reports",
    pattern:
      /gh[\s\S]*run[\s\S]*download[\s\S]*remote-capability-cloud-live-report[\s\S]*remote-capability-provider-live-report[\s\S]*test:remote-capabilities:validate-live-reports[\s\S]*--kind[\s\S]*cloud[\s\S]*test:remote-capabilities:validate-live-reports[\s\S]*--kind[\s\S]*provider[\s\S]*--require-providers[\s\S]*e2b,home-machine,mobile-companion/,
    source: "github-live-artifact-validator",
    message:
      "GitHub live artifact validation must download both artifacts and validate Cloud plus required provider report contents.",
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
    name: "provider live reports include endpoint runtime evidence",
    pattern:
      /providerEvidence:[\s\S]*provider:\s*target\.label[\s\S]*endpointRuntime:\s*target\.endpointRuntime[\s\S]*agentRuntime:\s*"github-actions"[\s\S]*connection:\s*"url-backed-provider"/,
    source: "provider-smoke",
    message:
      "provider live reports must record the provider family, endpoint runtime, agent runtime, and URL-backed adapter path.",
  },
  {
    name: "live report validator requires provider runtime evidence",
    pattern:
      /function validateProviderEvidence[\s\S]*providerEvidence\.provider must match provider[\s\S]*CANONICAL_PROVIDER_ENDPOINT_RUNTIMES[\s\S]*providerEvidence\.agentRuntime must be "github-actions"[\s\S]*providerEvidence\.connection must be "url-backed-provider"/,
    source: "live-report-validator",
    message:
      "live report validation must require provider runtime evidence for provider reports.",
  },
  {
    name: "live report validator self-test covers provider runtime evidence",
    pattern:
      /(?=[\s\S]*missingProviderEvidenceDir)(?=[\s\S]*mismatchedProviderEvidenceDir)(?=[\s\S]*makeMissingProviderEvidenceReport\(\))(?=[\s\S]*makeMismatchedProviderEvidenceReport\(\))(?=[\s\S]*providerEvidence must be an object)(?=[\s\S]*providerEvidence\.endpointRuntime must be)/,
    source: "live-report-validator-self-test",
    message:
      "live report validator self-test must cover missing and mismatched provider runtime evidence.",
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
    name: "endpoint conformance verifies view asset bytes",
    pattern:
      /const assetBytes = Buffer\.from\(assetResult\.bodyBase64, "base64"\)[\s\S]*const byteLength = assetBytes\.byteLength[\s\S]*byteLength === 0[\s\S]*returned an empty view asset[\s\S]*createHash\("sha256"\)\.update\(assetBytes\)\.digest\("hex"\)/,
    source: "endpoint-conformance",
    message:
      "endpoint conformance must fetch non-empty view asset bytes and record their SHA-256 digest.",
  },
  {
    name: "endpoint conformance verifies view asset integrity against bytes",
    pattern:
      /function assertAssetIntegrity\([\s\S]*bytes: Buffer[\s\S]*createHash\(algorithm\)\.update\(bytes\)\.digest\("base64"\)[\s\S]*token\.startsWith\("sha256-"\)[\s\S]*digest && digest === expectedDigests\.get\(algorithm\)[\s\S]*view asset integrity value that does not match its bytes/,
    source: "endpoint-conformance",
    message:
      "endpoint conformance must compare returned view asset integrity values with fetched bytes.",
  },
  {
    name: "live report validator requires non-empty route bodies",
    pattern:
      /isMeaningfulJsonEvidence\(routeResult\.body\)[\s\S]*conformance\.routeResult\.body must be a non-empty JSON value[\s\S]*function isMeaningfulJsonEvidence[\s\S]*value === undefined \|\| value === null[\s\S]*Array\.isArray\(value\)[\s\S]*Object\.keys\(value\)\.length > 0/,
    source: "live-report-validator",
    message:
      "live report validation must reject route results without non-empty JSON body evidence.",
  },
  {
    name: "live report validator verifies view asset metadata",
    pattern:
      /conformance\.assetResult\.path[\s\S]*\.\(\?:js\|mjs\)\$[\s\S]*conformance\.assetResult\.contentType must be JavaScript[\s\S]*manifestContentType !== undefined &&[\s\S]*manifestContentType !== assetContentType[\s\S]*manifestIntegrity !== undefined &&[\s\S]*manifestIntegrity !== assetIntegrity/,
    source: "live-report-validator",
    message:
      "live report validation must reject non-JavaScript and manifest-mismatched view asset evidence.",
  },
  {
    name: "live report validator verifies view asset digest evidence",
    pattern:
      /conformance\.assetResult\.byteLength[\s\S]*byteLength <= 0[\s\S]*conformance\.assetResult\.sha256[\s\S]*\^\[0-9a-f\]\{64\}\$[\s\S]*assetSha256\.toLowerCase\(\) === EMPTY_SHA256[\s\S]*validateAssetIntegritySha256\(assetIntegrity, assetSha256\.toLowerCase\(\)\)/,
    source: "live-report-validator",
    message:
      "live report validation must reject empty, malformed, and integrity-mismatched view asset digests.",
  },
  {
    name: "live report validator compares view asset integrity to digest",
    pattern:
      /function validateAssetIntegritySha256[\s\S]*filter\(\(token\) => token\.startsWith\("sha256-"\)\)[\s\S]*Buffer\.from\(assetSha256, "hex"\)\.toString\("base64"\)[\s\S]*sha256Tokens\.includes\(`sha256-\$\{expectedDigest\}`\)[\s\S]*conformance\.assetResult\.integrity must match conformance\.assetResult\.sha256/,
    source: "live-report-validator",
    message:
      "live report validation must compare view asset integrity tokens with the recorded SHA-256 digest.",
  },
  {
    name: "live report validator self-test covers non-JavaScript asset failures",
    pattern:
      /nonJavascriptAssetDir[\s\S]*makeNonJavascriptAssetReport\(\)[\s\S]*conformance\.assetResult\.path must be a JavaScript asset/,
    source: "live-report-validator-self-test",
    message:
      "live report validator self-test must cover non-JavaScript asset evidence.",
  },
  {
    name: "live report validator self-test covers missing route body failures",
    pattern:
      /missingRouteBodyDir[\s\S]*makeMissingRouteBodyReport\(\)[\s\S]*conformance\.routeResult\.body must be a non-empty JSON value/,
    source: "live-report-validator-self-test",
    message:
      "live report validator self-test must cover missing route body evidence.",
  },
  {
    name: "live report validator self-test covers empty route body failures",
    pattern:
      /emptyRouteBodyDir[\s\S]*makeEmptyRouteBodyReport\(\)[\s\S]*conformance\.routeResult\.body must be a non-empty JSON value/,
    source: "live-report-validator-self-test",
    message:
      "live report validator self-test must cover empty route body evidence.",
  },
  {
    name: "live report validator self-test covers manifest-mismatched asset failures",
    pattern:
      /mismatchedAssetManifestDir[\s\S]*makeMismatchedAssetManifestReport\(\)[\s\S]*conformance\.assetResult\.manifestContentType must match/,
    source: "live-report-validator-self-test",
    message:
      "live report validator self-test must cover manifest-mismatched asset evidence.",
  },
  {
    name: "live report validator self-test covers missing asset digest failures",
    pattern:
      /missingAssetDigestDir[\s\S]*makeMissingAssetDigestReport\(\)[\s\S]*conformance\.assetResult\.sha256 must be a non-empty string/,
    source: "live-report-validator-self-test",
    message:
      "live report validator self-test must cover missing view asset digests.",
  },
  {
    name: "live report validator self-test covers malformed asset digest failures",
    pattern:
      /malformedAssetDigestDir[\s\S]*makeMalformedAssetDigestReport\(\)[\s\S]*conformance\.assetResult\.sha256 has invalid format/,
    source: "live-report-validator-self-test",
    message:
      "live report validator self-test must cover malformed view asset digests.",
  },
  {
    name: "live report validator self-test covers empty asset digest failures",
    pattern:
      /emptyAssetDigestDir[\s\S]*makeEmptyAssetDigestReport\(\)[\s\S]*conformance\.assetResult\.sha256 must not be the empty SHA-256 digest/,
    source: "live-report-validator-self-test",
    message:
      "live report validator self-test must cover empty view asset digests.",
  },
  {
    name: "live report validator self-test covers mismatched asset integrity failures",
    pattern:
      /mismatchedAssetIntegrityDir[\s\S]*makeMismatchedAssetIntegrityReport\(\)[\s\S]*conformance\.assetResult\.integrity must match conformance\.assetResult\.sha256/,
    source: "live-report-validator-self-test",
    message:
      "live report validator self-test must cover mismatched view asset integrity evidence.",
  },
  {
    name: "live report validator self-test covers missing sha256 asset integrity failures",
    pattern:
      /missingSha256AssetIntegrityDir[\s\S]*makeMissingSha256AssetIntegrityReport\(\)[\s\S]*conformance\.assetResult\.integrity must include a sha256 digest/,
    source: "live-report-validator-self-test",
    message:
      "live report validator self-test must cover missing-sha256 view asset integrity evidence.",
  },
  {
    name: "provider live job is required by test-status",
    pattern: /strict_results="\$\{\{\s*github\.event_name == 'workflow_dispatch' \|\| github\.event_name == 'schedule'\s*\}\}"[\s\S]*for pair in\s*\\[\s\S]*"cloud-live-e2e:\$\{\{\s*needs\.cloud-live-e2e\.result\s*\}\}"\s*\\[\s\S]*"provider-live-e2e:\$\{\{\s*needs\.provider-live-e2e\.result\s*\}\}"/,
    message:
      "test-status must fail when cloud-live-e2e or provider-live-e2e are not successful on workflow_dispatch or schedule.",
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
    liveReportValidatorSelfTestSource?: string;
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
    liveReportValidatorSelfTestSource?: string;
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
  if (check.source === "live-report-validator-self-test") {
    return options.liveReportValidatorSelfTestSource ?? "";
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
  if (check.source === "live-report-validator-self-test") {
    return liveReportValidatorSelfTestPath;
  }
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
  const liveReportValidatorSelfTestSource = readFileSync(
    liveReportValidatorSelfTestPath,
    "utf8",
  );
  const liveReportWriterSource = readFileSync(liveReportWriterPath, "utf8");
  const providerSmokeSource = readFileSync(providerSmokePath, "utf8");
  const failures = validateCapabilityRouterLiveCi(workflow, {
    agentPackageJson,
    endpointConformanceSource,
    liveReportValidatorSelfTestSource,
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
