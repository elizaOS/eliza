import { readFileSync } from "node:fs";
import {
  checks,
  validateCapabilityRouterLiveCi,
} from "./audit-capability-router-live-ci.ts";

const workflowPath = ".github/workflows/test.yml";
const workflow = readFileSync(workflowPath, "utf8");
const rootPackageJson = readFileSync("package.json", "utf8");
const agentPackageJson = readFileSync("packages/agent/package.json", "utf8");
const coreCapabilitiesSource = readFileSync(
  "packages/core/src/capabilities/index.ts",
  "utf8",
);
const endpointConformanceSource = readFileSync(
  "packages/agent/src/services/remote-capability-endpoint-conformance.ts",
  "utf8",
);
const remoteCapabilityRoutesSource = readFileSync(
  "packages/agent/src/api/remote-capability-routes.ts",
  "utf8",
);
const liveReportValidatorSource = readFileSync(
  "packages/scripts/validate-capability-router-live-reports.ts",
  "utf8",
);
const liveReportValidatorSelfTestSource = readFileSync(
  "packages/scripts/validate-capability-router-live-reports.self-test.ts",
  "utf8",
);
const liveReportWriterSource = readFileSync(
  "packages/agent/src/services/remote-capability-live-report.ts",
  "utf8",
);
const providerSmokeSource = readFileSync(
  "packages/agent/src/services/remote-capability-url-endpoint-providers.provider-smoke.test.ts",
  "utf8",
);
const remotePluginAdapterTestSource = readFileSync(
  "packages/agent/src/services/remote-plugin-adapter.test.ts",
  "utf8",
);
const githubLiveArtifactValidatorSource = readFileSync(
  "packages/scripts/validate-capability-router-github-live-artifacts.ts",
  "utf8",
);
const githubLiveArtifactValidatorSelfTestSource = readFileSync(
  "packages/scripts/validate-capability-router-github-live-artifacts.self-test.ts",
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

assertFails(
  "GitHub live evidence validator self-test is a CI gate",
  workflow.replace(
    "      - name: Remote capability GitHub live evidence self-test\n        run: bun run test:remote-capabilities:github-live-evidence:self-test\n\n",
    "",
  ),
);

assertFails(
  "GitHub live artifact validator self-test is a CI gate",
  workflow.replace(
    "      - name: Remote capability GitHub live artifact self-test\n        run: bun run test:remote-capabilities:github-live-artifacts:self-test\n\n",
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

assertRootPackageFailure(
  "GitHub live evidence validator script exists",
  rootPackageJson.replace(
    '    "test:remote-capabilities:github-live-evidence": "bun packages/scripts/validate-capability-router-github-live-evidence.ts",\n',
    "",
  ),
);

assertRootPackageFailure(
  "GitHub live artifact validator script exists",
  rootPackageJson.replace(
    '    "test:remote-capabilities:github-live-artifacts": "bun packages/scripts/validate-capability-router-github-live-artifacts.ts",\n',
    "",
  ),
);

assertRootPackageFailure(
  "GitHub live evidence validator self-test script exists",
  rootPackageJson.replace(
    '    "test:remote-capabilities:github-live-evidence:self-test": "bun packages/scripts/validate-capability-router-github-live-evidence.self-test.ts",\n',
    "",
  ),
);

assertRootPackageFailure(
  "GitHub live artifact validator self-test script exists",
  rootPackageJson.replace(
    '    "test:remote-capabilities:github-live-artifacts:self-test": "bun packages/scripts/validate-capability-router-github-live-artifacts.self-test.ts",\n',
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

const endpointScopedUnloadFailure = assertFails(
  "remote adapter test covers endpoint-scoped stale unload",
  workflow,
  rootPackageJson,
  agentPackageJson,
  providerSmokeSource,
  liveReportValidatorSource,
  liveReportWriterSource,
  endpointConformanceSource,
  liveReportValidatorSelfTestSource,
  githubLiveArtifactValidatorSource,
  githubLiveArtifactValidatorSelfTestSource,
  remotePluginAdapterTestSource.replace(
    "scopes stale unloads to the selected endpoint so another device remains loaded",
    "scopes stale unloads",
  ),
);
if (
  endpointScopedUnloadFailure.sourcePath !==
  "packages/agent/src/services/remote-plugin-adapter.test.ts"
) {
  throw new Error(
    `endpoint-scoped unload failure reported wrong source path: ${endpointScopedUnloadFailure.sourcePath}`,
  );
}

const provenanceProtocolFailure = assertFails(
  "core capability protocol includes signed module provenance",
  workflow,
  rootPackageJson,
  agentPackageJson,
  providerSmokeSource,
  liveReportValidatorSource,
  liveReportWriterSource,
  endpointConformanceSource,
  liveReportValidatorSelfTestSource,
  githubLiveArtifactValidatorSource,
  githubLiveArtifactValidatorSelfTestSource,
  remotePluginAdapterTestSource,
  remoteCapabilityRoutesSource,
  coreCapabilitiesSource.replace(
    "export type RemotePluginModuleProvenance",
    "type RemotePluginModuleProvenanceDisabled",
  ),
);
if (
  provenanceProtocolFailure.sourcePath !==
  "packages/core/src/capabilities/index.ts"
) {
  throw new Error(
    `provenance protocol failure reported wrong source path: ${provenanceProtocolFailure.sourcePath}`,
  );
}

const trustAuditRouteFailure = assertFails(
  "product connect persists redacted trust audit records",
  workflow,
  rootPackageJson,
  agentPackageJson,
  providerSmokeSource,
  liveReportValidatorSource,
  liveReportWriterSource,
  endpointConformanceSource,
  liveReportValidatorSelfTestSource,
  githubLiveArtifactValidatorSource,
  githubLiveArtifactValidatorSelfTestSource,
  remotePluginAdapterTestSource,
  remoteCapabilityRoutesSource.replace(
    "endpoint: redactEndpoint(audit.endpoint),",
    "endpoint: audit.endpoint as never,",
  ),
);
if (
  trustAuditRouteFailure.sourcePath !==
  "packages/agent/src/api/remote-capability-routes.ts"
) {
  throw new Error(
    `trust audit route failure reported wrong source path: ${trustAuditRouteFailure.sourcePath}`,
  );
}

const trustAuditTestFailure = assertFails(
  "remote adapter test covers redacted product trust audit records",
  workflow,
  rootPackageJson,
  agentPackageJson,
  providerSmokeSource,
  liveReportValidatorSource,
  liveReportWriterSource,
  endpointConformanceSource,
  liveReportValidatorSelfTestSource,
  githubLiveArtifactValidatorSource,
  githubLiveArtifactValidatorSelfTestSource,
  remotePluginAdapterTestSource.replace(
    '      expect(JSON.stringify(trustAudit)).not.toContain("product-token");\n',
    "",
  ),
);
if (
  trustAuditTestFailure.sourcePath !==
  "packages/agent/src/services/remote-plugin-adapter.test.ts"
) {
  throw new Error(
    `trust audit test failure reported wrong source path: ${trustAuditTestFailure.sourcePath}`,
  );
}

const cloudRestartViewFailure = assertFails(
  "remote adapter test covers Cloud provision restart reopened view",
  workflow,
  rootPackageJson,
  agentPackageJson,
  providerSmokeSource,
  liveReportValidatorSource,
  liveReportWriterSource,
  endpointConformanceSource,
  liveReportValidatorSelfTestSource,
  githubLiveArtifactValidatorSource,
  githubLiveArtifactValidatorSelfTestSource,
  remotePluginAdapterTestSource.replace(
    "reopens a persisted Cloud-provisioned remote view after restart",
    "reopens a persisted Cloud-provisioned remote view",
  ),
);
if (
  cloudRestartViewFailure.sourcePath !==
  "packages/agent/src/services/remote-plugin-adapter.test.ts"
) {
  throw new Error(
    `cloud restart view failure reported wrong source path: ${cloudRestartViewFailure.sourcePath}`,
  );
}

const provenanceTrustPolicyFailure = assertFails(
  "remote adapter test covers signed provenance trust policy",
  workflow,
  rootPackageJson,
  agentPackageJson,
  providerSmokeSource,
  liveReportValidatorSource,
  liveReportWriterSource,
  endpointConformanceSource,
  liveReportValidatorSelfTestSource,
  githubLiveArtifactValidatorSource,
  githubLiveArtifactValidatorSelfTestSource,
  remotePluginAdapterTestSource.replaceAll(
    "requireSignedProvenance: true,",
    "requireSignedProvenance: false,",
  ),
);
if (
  provenanceTrustPolicyFailure.sourcePath !==
  "packages/agent/src/services/remote-plugin-adapter.test.ts"
) {
  throw new Error(
    `provenance trust policy failure reported wrong source path: ${provenanceTrustPolicyFailure.sourcePath}`,
  );
}

const provenanceVerificationFailure = assertFails(
  "remote adapter test covers signed provenance trust policy",
  workflow,
  rootPackageJson,
  agentPackageJson,
  providerSmokeSource,
  liveReportValidatorSource,
  liveReportWriterSource,
  endpointConformanceSource,
  liveReportValidatorSelfTestSource,
  githubLiveArtifactValidatorSource,
  githubLiveArtifactValidatorSelfTestSource,
  remotePluginAdapterTestSource.replaceAll(
    "requireVerifiedProvenance: true,",
    "requireVerifiedProvenance: false,",
  ),
);
if (
  provenanceVerificationFailure.sourcePath !==
  "packages/agent/src/services/remote-plugin-adapter.test.ts"
) {
  throw new Error(
    `provenance verification failure reported wrong source path: ${provenanceVerificationFailure.sourcePath}`,
  );
}

const provenanceDigestFailure = assertFails(
  "remote adapter test covers signed provenance trust policy",
  workflow,
  rootPackageJson,
  agentPackageJson,
  providerSmokeSource,
  liveReportValidatorSource,
  liveReportWriterSource,
  endpointConformanceSource,
  liveReportValidatorSelfTestSource,
  githubLiveArtifactValidatorSource,
  githubLiveArtifactValidatorSelfTestSource,
  remotePluginAdapterTestSource.replaceAll(
    "requireProvenanceDigestMatch: true,",
    "requireProvenanceDigestMatch: false,",
  ),
);
if (
  provenanceDigestFailure.sourcePath !==
  "packages/agent/src/services/remote-plugin-adapter.test.ts"
) {
  throw new Error(
    `provenance digest failure reported wrong source path: ${provenanceDigestFailure.sourcePath}`,
  );
}

const productTrustPolicyFailure = assertFails(
  "product connect persists provenance trust policy",
  workflow,
  rootPackageJson,
  agentPackageJson,
  providerSmokeSource,
  liveReportValidatorSource,
  liveReportWriterSource,
  endpointConformanceSource,
  liveReportValidatorSelfTestSource,
  githubLiveArtifactValidatorSource,
  githubLiveArtifactValidatorSelfTestSource,
  remotePluginAdapterTestSource,
  remoteCapabilityRoutesSource.replaceAll(
    "ELIZA_CAPABILITY_ROUTER_TRUST_POLICY",
    "ELIZA_CAPABILITY_ROUTER_TRUST_CONFIG",
  ),
);
if (
  productTrustPolicyFailure.sourcePath !==
  "packages/agent/src/api/remote-capability-routes.ts"
) {
  throw new Error(
    `product trust policy failure reported wrong source path: ${productTrustPolicyFailure.sourcePath}`,
  );
}

const writerFailure = assertFails(
  "live report writer records runtime module surface counts",
  workflow,
  rootPackageJson,
  agentPackageJson,
  providerSmokeSource,
  liveReportValidatorSource,
  liveReportWriterSource.replace(
    "        ...summarizeRemoteCapabilityPluginSurfaces(plugin),\n",
    "",
  ),
);
if (
  writerFailure.sourcePath !==
  "packages/agent/src/services/remote-capability-live-report.ts"
) {
  throw new Error(
    `live report writer failure reported wrong source path: ${writerFailure.sourcePath}`,
  );
}

const validatorFailure = assertFails(
  "live report validator compares runtime module surface counts",
  workflow,
  rootPackageJson,
  agentPackageJson,
  providerSmokeSource,
  liveReportValidatorSource.replace(
    "          `runtime.remotePlugins[${index}].${field} must match sync.registeredModules.`,\n",
    "",
  ),
  liveReportWriterSource,
);
if (
  validatorFailure.sourcePath !==
  "packages/scripts/validate-capability-router-live-reports.ts"
) {
  throw new Error(
    `live report validator failure reported wrong source path: ${validatorFailure.sourcePath}`,
  );
}

const endpointConformanceFailure = assertFails(
  "endpoint conformance requires non-empty route bodies",
  workflow,
  rootPackageJson,
  agentPackageJson,
  providerSmokeSource,
  liveReportValidatorSource,
  liveReportWriterSource,
  endpointConformanceSource.replace(
    "  if (!hasMeaningfulRouteBody(result.body)) {\n",
    "  if (!hasOwn(result, \"body\") || result.body === undefined) {\n",
  ),
);
if (
  endpointConformanceFailure.sourcePath !==
  "packages/agent/src/services/remote-capability-endpoint-conformance.ts"
) {
  throw new Error(
    `endpoint conformance failure reported wrong source path: ${endpointConformanceFailure.sourcePath}`,
  );
}

const assetBytesFailure = assertFails(
  "endpoint conformance verifies view asset bytes",
  workflow,
  rootPackageJson,
  agentPackageJson,
  providerSmokeSource,
  liveReportValidatorSource,
  liveReportWriterSource,
  endpointConformanceSource.replace(
    '      sha256: createHash("sha256").update(assetBytes).digest("hex"),\n',
    '      sha256: assetResult.integrity ?? "",\n',
  ),
);
if (
  assetBytesFailure.sourcePath !==
  "packages/agent/src/services/remote-capability-endpoint-conformance.ts"
) {
  throw new Error(
    `asset bytes conformance failure reported wrong source path: ${assetBytesFailure.sourcePath}`,
  );
}

const assetIntegrityFailure = assertFails(
  "endpoint conformance verifies view asset integrity against bytes",
  workflow,
  rootPackageJson,
  agentPackageJson,
  providerSmokeSource,
  liveReportValidatorSource,
  liveReportWriterSource,
  endpointConformanceSource.replace(
    "    if (digest && digest === expectedDigests.get(algorithm)) return;\n",
    "    if (digest) return;\n",
  ),
);
if (
  assetIntegrityFailure.sourcePath !==
  "packages/agent/src/services/remote-capability-endpoint-conformance.ts"
) {
  throw new Error(
    `asset integrity conformance failure reported wrong source path: ${assetIntegrityFailure.sourcePath}`,
  );
}

const routeBodyValidatorFailure = assertFails(
  "live report validator requires non-empty route bodies",
  workflow,
  rootPackageJson,
  agentPackageJson,
  providerSmokeSource,
  liveReportValidatorSource.replace(
    "  if (!isMeaningfulJsonEvidence(routeResult.body)) {\n",
    "  if (!Object.hasOwn(routeResult, \"body\") || routeResult.body === undefined) {\n",
  ),
  liveReportWriterSource,
  endpointConformanceSource,
);
if (
  routeBodyValidatorFailure.sourcePath !==
  "packages/scripts/validate-capability-router-live-reports.ts"
) {
  throw new Error(
    `route body validator failure reported wrong source path: ${routeBodyValidatorFailure.sourcePath}`,
  );
}

const assetMetadataValidatorFailure = assertFails(
  "live report validator verifies view asset metadata",
  workflow,
  rootPackageJson,
  agentPackageJson,
  providerSmokeSource,
  liveReportValidatorSource.replace(
    "    manifestIntegrity !== undefined &&\n    manifestIntegrity !== assetIntegrity\n",
    "    false\n",
  ),
  liveReportWriterSource,
  endpointConformanceSource,
);
if (
  assetMetadataValidatorFailure.sourcePath !==
  "packages/scripts/validate-capability-router-live-reports.ts"
) {
  throw new Error(
    `asset metadata validator failure reported wrong source path: ${assetMetadataValidatorFailure.sourcePath}`,
  );
}

const assetDigestValidatorFailure = assertFails(
  "live report validator verifies view asset digest evidence",
  workflow,
  rootPackageJson,
  agentPackageJson,
  providerSmokeSource,
  liveReportValidatorSource.replace(
    "  if (assetSha256.toLowerCase() === EMPTY_SHA256) {\n",
    "  if (false) {\n",
  ),
  liveReportWriterSource,
  endpointConformanceSource,
);
if (
  assetDigestValidatorFailure.sourcePath !==
  "packages/scripts/validate-capability-router-live-reports.ts"
) {
  throw new Error(
    `asset digest validator failure reported wrong source path: ${assetDigestValidatorFailure.sourcePath}`,
  );
}

const assetIntegrityValidatorFailure = assertFails(
  "live report validator compares view asset integrity to digest",
  workflow,
  rootPackageJson,
  agentPackageJson,
  providerSmokeSource,
  liveReportValidatorSource.replace(
    "  if (!sha256Tokens.includes(`sha256-${expectedDigest}`)) {\n",
    "  if (false) {\n",
  ),
  liveReportWriterSource,
  endpointConformanceSource,
);
if (
  assetIntegrityValidatorFailure.sourcePath !==
  "packages/scripts/validate-capability-router-live-reports.ts"
) {
  throw new Error(
    `asset integrity validator failure reported wrong source path: ${assetIntegrityValidatorFailure.sourcePath}`,
  );
}

assertValidatorSelfTestFailure(
  "live report validator self-test covers non-JavaScript asset failures",
  liveReportValidatorSelfTestSource.replace(
    "        \"conformance.assetResult.path must be a JavaScript asset\",\n",
    "",
  ),
);

assertValidatorSelfTestFailure(
  "live report validator self-test covers missing route body failures",
  liveReportValidatorSelfTestSource.replace(
    "makeMissingRouteBodyReport()",
    "makeCompleteReport(\"provider\")",
  ),
);

assertValidatorSelfTestFailure(
  "live report validator self-test covers empty route body failures",
  liveReportValidatorSelfTestSource.replace(
    "makeEmptyRouteBodyReport()",
    "makeCompleteReport(\"provider\")",
  ),
);

assertValidatorSelfTestFailure(
  "live report validator self-test covers manifest-mismatched asset failures",
  liveReportValidatorSelfTestSource.replace(
    "        \"conformance.assetResult.manifestContentType must match\",\n",
    "",
  ),
);

assertValidatorSelfTestFailure(
  "live report validator self-test covers missing asset digest failures",
  liveReportValidatorSelfTestSource.replace(
    "        \"conformance.assetResult.sha256 must be a non-empty string\",\n",
    "",
  ),
);

assertValidatorSelfTestFailure(
  "live report validator self-test covers malformed asset digest failures",
  liveReportValidatorSelfTestSource.replace(
    "        \"conformance.assetResult.sha256 has invalid format\",\n",
    "",
  ),
);

assertValidatorSelfTestFailure(
  "live report validator self-test covers empty asset digest failures",
  liveReportValidatorSelfTestSource.replace(
    "        \"conformance.assetResult.sha256 must not be the empty SHA-256 digest\",\n",
    "",
  ),
);

assertValidatorSelfTestFailure(
  "live report validator self-test covers mismatched asset integrity failures",
  liveReportValidatorSelfTestSource.replace(
    "        \"conformance.assetResult.integrity must match conformance.assetResult.sha256\",\n",
    "",
  ),
);

assertValidatorSelfTestFailure(
  "live report validator self-test covers missing sha256 asset integrity failures",
  liveReportValidatorSelfTestSource.replace(
    "        \"conformance.assetResult.integrity must include a sha256 digest\",\n",
    "",
  ),
);

assertFails(
  "cloud live job is required by test-status",
  // Replace in test-status.needs specifically: "desktop-contract\n      - cloud-live-e2e\n"
  // is unique to that block. github-live-artifact-validate has no desktop-contract dep,
  // so a plain replace("      - cloud-live-e2e\n", ...) would hit that job first.
  workflow.replace(
    "      - desktop-contract\n      - cloud-live-e2e\n",
    "      - desktop-contract\n",
  ),
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
    "strict_results=\"${{ github.event_name == 'workflow_dispatch' || github.event_name == 'schedule' }}\"",
    "strict_results=\"${{ github.event_name == 'workflow_dispatch' }}\"",
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
  "cloud live credentials are required on observed runs",
  workflow.replace(
    '              echo "::error::No Eliza Cloud API key configured for observed cloud live E2E."\n              exit 1\n',
    '              echo "::warning::No Eliza Cloud API key configured for observed cloud live E2E."\n              echo "skip=true" >> "$GITHUB_OUTPUT"\n',
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

const providerRuntimeEvidenceFailure = assertFails(
  "provider live reports include endpoint runtime evidence",
  workflow,
  rootPackageJson,
  agentPackageJson,
  providerSmokeSource.replace(
    "            endpointRuntime: target.endpointRuntime,\n",
    "",
  ),
);
if (
  providerRuntimeEvidenceFailure.sourcePath !==
  "packages/agent/src/services/remote-capability-url-endpoint-providers.provider-smoke.test.ts"
) {
  throw new Error(
    `provider runtime evidence failure reported wrong source path: ${providerRuntimeEvidenceFailure.sourcePath}`,
  );
}

const validatorProviderEvidenceFailure = assertFails(
  "live report validator requires provider runtime evidence",
  workflow,
  rootPackageJson,
  agentPackageJson,
  providerSmokeSource,
  liveReportValidatorSource.replace(
    'providerEvidence.agentRuntime must be "github-actions"',
    'providerEvidence.agentRuntime disabled',
  ),
);
if (
  validatorProviderEvidenceFailure.sourcePath !==
  "packages/scripts/validate-capability-router-live-reports.ts"
) {
  throw new Error(
    `validator provider evidence failure reported wrong source path: ${validatorProviderEvidenceFailure.sourcePath}`,
  );
}

assertValidatorSelfTestFailure(
  "live report validator self-test covers provider runtime evidence",
  liveReportValidatorSelfTestSource.replace(
    "providerEvidence must be an object",
    "providerEvidence disabled check",
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
  "provider live endpoints are required on observed runs",
  workflow.replace(
    '              echo "::error::No remote capability provider endpoints configured for observed provider live E2E."\n              exit 1\n',
    '              echo "::warning::No remote capability provider endpoints configured for observed provider live E2E."\n              echo "skip=true" >> "$GITHUB_OUTPUT"\n',
  ),
);

assertFails(
  "provider live primary endpoints are required on observed runs",
  workflow.replace(
    '              echo "::error::${message}"\n              exit 1\n',
    '              echo "::notice::${message}"\n              echo "skip=true" >> "$GITHUB_OUTPUT"\n',
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

const githubArtifactValidatorFailure = assertFails(
  "GitHub live artifact validator downloads and validates reports",
  workflow,
  rootPackageJson,
  agentPackageJson,
  providerSmokeSource,
  liveReportValidatorSource,
  liveReportWriterSource,
  endpointConformanceSource,
  liveReportValidatorSelfTestSource,
  githubLiveArtifactValidatorSource.replace(
    "      \"e2b,home-machine,mobile-companion\",\n",
    "      \"e2b,home-machine\",\n",
  ),
);
if (
  githubArtifactValidatorFailure.sourcePath !==
  "packages/scripts/validate-capability-router-github-live-artifacts.ts"
) {
  throw new Error(
    `github live artifact validator failure reported wrong source path: ${githubArtifactValidatorFailure.sourcePath}`,
  );
}

assertGithubArtifactValidatorSelfTestFailure(
  "GitHub live artifact validator self-test covers downloaded reports",
  githubLiveArtifactValidatorSelfTestSource.replace(
    'assertCommand("downloads both named artifacts", "gh", [',
    'assertCommand("downloads artifact", "gh", [',
  ),
);

assertGithubArtifactValidatorSelfTestFailure(
  "GitHub live artifact validator self-test covers provider requirements",
  githubLiveArtifactValidatorSelfTestSource.replace(
    '"e2b,home-machine,mobile-companion",',
    '"e2b,home-machine",',
  ),
);

assertGithubArtifactValidatorSelfTestFailure(
  "GitHub live artifact validator self-test rejects push runs before download",
  githubLiveArtifactValidatorSelfTestSource.replace(
    '"push run is rejected before artifact download",',
    '"push run is rejected",',
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
  candidateLiveReportValidatorSource = liveReportValidatorSource,
  candidateLiveReportWriterSource = liveReportWriterSource,
  candidateEndpointConformanceSource = endpointConformanceSource,
  candidateLiveReportValidatorSelfTestSource = liveReportValidatorSelfTestSource,
  candidateGithubLiveArtifactValidatorSource = githubLiveArtifactValidatorSource,
  candidateGithubLiveArtifactValidatorSelfTestSource = githubLiveArtifactValidatorSelfTestSource,
  candidateRemotePluginAdapterTestSource = remotePluginAdapterTestSource,
  candidateRemoteCapabilityRoutesSource = remoteCapabilityRoutesSource,
  candidateCoreCapabilitiesSource = coreCapabilitiesSource,
): void {
  const failures = validateCapabilityRouterLiveCi(candidate, {
    agentPackageJson: candidateAgentPackageJson,
    coreCapabilitiesSource: candidateCoreCapabilitiesSource,
    endpointConformanceSource: candidateEndpointConformanceSource,
    githubLiveArtifactValidatorSource:
      candidateGithubLiveArtifactValidatorSource,
    githubLiveArtifactValidatorSelfTestSource:
      candidateGithubLiveArtifactValidatorSelfTestSource,
    liveReportValidatorSelfTestSource:
      candidateLiveReportValidatorSelfTestSource,
    liveReportValidatorSource: candidateLiveReportValidatorSource,
    liveReportWriterSource: candidateLiveReportWriterSource,
    providerSmokeSource: candidateProviderSmokeSource,
    remoteCapabilityRoutesSource: candidateRemoteCapabilityRoutesSource,
    remotePluginAdapterTestSource: candidateRemotePluginAdapterTestSource,
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
  candidateLiveReportValidatorSource = liveReportValidatorSource,
  candidateLiveReportWriterSource = liveReportWriterSource,
  candidateEndpointConformanceSource = endpointConformanceSource,
  candidateLiveReportValidatorSelfTestSource = liveReportValidatorSelfTestSource,
  candidateGithubLiveArtifactValidatorSource = githubLiveArtifactValidatorSource,
  candidateGithubLiveArtifactValidatorSelfTestSource = githubLiveArtifactValidatorSelfTestSource,
  candidateRemotePluginAdapterTestSource = remotePluginAdapterTestSource,
  candidateRemoteCapabilityRoutesSource = remoteCapabilityRoutesSource,
  candidateCoreCapabilitiesSource = coreCapabilitiesSource,
): ReturnType<typeof validateCapabilityRouterLiveCi>[number] {
  const failures = validateCapabilityRouterLiveCi(candidate, {
    agentPackageJson: candidateAgentPackageJson,
    coreCapabilitiesSource: candidateCoreCapabilitiesSource,
    endpointConformanceSource: candidateEndpointConformanceSource,
    githubLiveArtifactValidatorSource:
      candidateGithubLiveArtifactValidatorSource,
    githubLiveArtifactValidatorSelfTestSource:
      candidateGithubLiveArtifactValidatorSelfTestSource,
    liveReportValidatorSelfTestSource:
      candidateLiveReportValidatorSelfTestSource,
    liveReportValidatorSource: candidateLiveReportValidatorSource,
    liveReportWriterSource: candidateLiveReportWriterSource,
    providerSmokeSource: candidateProviderSmokeSource,
    remoteCapabilityRoutesSource: candidateRemoteCapabilityRoutesSource,
    remotePluginAdapterTestSource: candidateRemotePluginAdapterTestSource,
    rootPackageJson: candidateRootPackageJson,
    workflowPath: "mutated-workflow.yml",
    onlyCheckNames: [expectedCheckName],
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

function assertValidatorSelfTestFailure(
  expectedCheckName: string,
  candidateLiveReportValidatorSelfTestSource: string,
): void {
  const failure = assertFails(
    expectedCheckName,
    workflow,
    rootPackageJson,
    agentPackageJson,
    providerSmokeSource,
    liveReportValidatorSource,
    liveReportWriterSource,
    endpointConformanceSource,
    candidateLiveReportValidatorSelfTestSource,
  );
  if (
    failure.sourcePath !==
    "packages/scripts/validate-capability-router-live-reports.self-test.ts"
  ) {
    throw new Error(
      `live report validator self-test failure reported wrong source path: ${failure.sourcePath}`,
    );
  }
}

function assertGithubArtifactValidatorSelfTestFailure(
  expectedCheckName: string,
  candidateGithubLiveArtifactValidatorSelfTestSource: string,
): void {
  const failure = assertFails(
    expectedCheckName,
    workflow,
    rootPackageJson,
    agentPackageJson,
    providerSmokeSource,
    liveReportValidatorSource,
    liveReportWriterSource,
    endpointConformanceSource,
    liveReportValidatorSelfTestSource,
    githubLiveArtifactValidatorSource,
    candidateGithubLiveArtifactValidatorSelfTestSource,
  );
  if (
    failure.sourcePath !==
    "packages/scripts/validate-capability-router-github-live-artifacts.self-test.ts"
  ) {
    throw new Error(
      `github live artifact validator self-test failure reported wrong source path: ${failure.sourcePath}`,
    );
  }
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
