/** Exercises live-report CLI admission with deterministic files and real subprocesses. */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "validate-capability-router-live-reports.ts",
);

async function main(): Promise<void> {
  const workspace = await mkdtemp(
    join(tmpdir(), "capability-router-live-report-self-test-"),
  );
  try {
    const completeDir = join(workspace, "complete");
    const completeExtraExercisesDir = join(
      workspace,
      "complete-extra-exercises",
    );
    const completePartialModuleDir = join(workspace, "complete-partial-module");
    const cloudOnlyDir = join(workspace, "cloud-only");
    const ciDir = join(workspace, "ci");
    const providerCiDir = join(workspace, "provider-ci");
    const malformedCiDir = join(workspace, "malformed-ci");
    const pushCiDir = join(workspace, "push-ci");
    const providerOnlyDir = join(workspace, "provider-only");
    const requiredProvidersDir = join(workspace, "required-providers");
    const threeProvidersDir = join(workspace, "three-providers");
    const expectedCountDir = join(workspace, "expected-count");
    const unknownProviderDir = join(workspace, "unknown-provider");
    const freshDir = join(workspace, "fresh");
    const staleDir = join(workspace, "stale");
    const nearFutureDir = join(workspace, "near-future");
    const farFutureDir = join(workspace, "far-future");
    const malformedObservedAtDir = join(workspace, "malformed-observed-at");
    const wrongSchemaDir = join(workspace, "wrong-schema");
    const partialDir = join(workspace, "partial");
    const failedRouteDir = join(workspace, "failed-route");
    const missingRouteBodyDir = join(workspace, "missing-route-body");
    const emptyRouteBodyDir = join(workspace, "empty-route-body");
    const missingModelResultDir = join(workspace, "missing-model-result");
    const emptyActionResultDir = join(workspace, "empty-action-result");
    const emptyProviderResultDir = join(workspace, "empty-provider-result");
    const failedLifecycleDir = join(workspace, "failed-lifecycle");
    const unhandledEventDir = join(workspace, "unhandled-event");
    const missingServiceResultDir = join(workspace, "missing-service-result");
    const missingAppBridgeResultDir = join(
      workspace,
      "missing-app-bridge-result",
    );
    const emptyEvaluatorProcessDir = join(workspace, "empty-evaluator-process");
    const emptyResponseHandlerEvaluateDir = join(
      workspace,
      "empty-response-handler-evaluate",
    );
    const emptyFieldEvaluatorParseDir = join(
      workspace,
      "empty-field-evaluator-parse",
    );
    const emptyFieldEvaluatorHandleDir = join(
      workspace,
      "empty-field-evaluator-handle",
    );
    const nonJavascriptAssetDir = join(workspace, "non-javascript-asset");
    const mismatchedAssetManifestDir = join(
      workspace,
      "mismatched-asset-manifest",
    );
    const mismatchedAssetIntegrityDir = join(
      workspace,
      "mismatched-asset-integrity",
    );
    const missingSha256AssetIntegrityDir = join(
      workspace,
      "missing-sha256-asset-integrity",
    );
    const missingAssetDigestDir = join(workspace, "missing-asset-digest");
    const malformedAssetDigestDir = join(workspace, "malformed-asset-digest");
    const emptyAssetDigestDir = join(workspace, "empty-asset-digest");
    const mismatchDir = join(workspace, "mismatch");
    const malformedEndpointIdDir = join(workspace, "malformed-endpoint-id");
    const malformedModuleIdDir = join(workspace, "malformed-module-id");
    const malformedProviderDir = join(workspace, "malformed-provider");
    const malformedCloudApiBaseDir = join(
      workspace,
      "malformed-cloud-api-base",
    );
    const cloudProviderFieldDir = join(workspace, "cloud-provider-field");
    const providerCloudFieldDir = join(workspace, "provider-cloud-field");
    const cloudApiBaseQueryDir = join(workspace, "cloud-api-base-query");
    const cloudApiBaseFragmentDir = join(workspace, "cloud-api-base-fragment");
    const matchingFileIdentityDir = join(workspace, "matching-file-identity");
    const mismatchedFileIdentityDir = join(
      workspace,
      "mismatched-file-identity",
    );
    const mismatchedCloudFileIdentityDir = join(
      workspace,
      "mismatched-cloud-file-identity",
    );
    const duplicateEndpointDir = join(workspace, "duplicate-endpoint");
    const duplicateProviderDir = join(workspace, "duplicate-provider");
    const duplicateEndpointUrlFingerprintDir = join(
      workspace,
      "duplicate-endpoint-url-fingerprint",
    );
    const missingProviderIdDir = join(workspace, "missing-provider-id");
    const mismatchedProviderIdDir = join(workspace, "mismatched-provider-id");
    const missingProviderEvidenceDir = join(
      workspace,
      "missing-provider-evidence",
    );
    const mismatchedProviderEvidenceDir = join(
      workspace,
      "mismatched-provider-evidence",
    );
    const missingEndpointUrlFingerprintDir = join(
      workspace,
      "missing-endpoint-url-fingerprint",
    );
    const malformedEndpointUrlFingerprintDir = join(
      workspace,
      "malformed-endpoint-url-fingerprint",
    );
    const leakedSecretDir = join(workspace, "leaked-secret");
    const leakedSecretValueDir = join(workspace, "leaked-secret-value");
    const bogusTargetDir = join(workspace, "bogus-target");
    const malformedTargetDir = join(workspace, "malformed-target");
    const bogusTrustDir = join(workspace, "bogus-trust");
    const bogusRegistrationDir = join(workspace, "bogus-registration");
    const duplicateModuleDir = join(workspace, "duplicate-module");
    const duplicateRegisteredModuleDir = join(
      workspace,
      "duplicate-registered-module",
    );
    const duplicateRegisteredPluginDir = join(
      workspace,
      "duplicate-registered-plugin",
    );
    const duplicateTrustDecisionDir = join(
      workspace,
      "duplicate-trust-decision",
    );
    const registeredSkippedDir = join(workspace, "registered-skipped");
    const registeredUnloadedDir = join(workspace, "registered-unloaded");
    const skippedUnloadedOverlapDir = join(
      workspace,
      "skipped-unloaded-overlap",
    );
    const skippedMissingTrustDir = join(workspace, "skipped-missing-trust");
    const duplicateSkippedDir = join(workspace, "duplicate-skipped");
    const duplicateUnloadedDir = join(workspace, "duplicate-unloaded");
    const exercisedUnregisteredDir = join(workspace, "exercised-unregistered");
    const registeredUnexercisedDir = join(workspace, "registered-unexercised");
    const missingSummaryModuleExerciseDir = join(
      workspace,
      "missing-summary-module-exercise",
    );
    const duplicateModuleExerciseDir = join(
      workspace,
      "duplicate-module-exercise",
    );
    const missingModuleExercisesDir = join(
      workspace,
      "missing-module-exercises",
    );
    const missingRpcCallsDir = join(workspace, "missing-rpc-calls");
    const invalidRpcMethodDir = join(workspace, "invalid-rpc-method");
    const missingRequiredRpcMethodDir = join(
      workspace,
      "missing-required-rpc-method",
    );
    const manifestOnlyUnregisteredDir = join(
      workspace,
      "manifest-only-unregistered",
    );
    const runtimeUndercountDir = join(workspace, "runtime-undercount");
    const runtimePluginUndercountDir = join(
      workspace,
      "runtime-plugin-undercount",
    );
    const missingRuntimeRemotePluginDir = join(
      workspace,
      "missing-runtime-remote-plugin",
    );
    const staleRuntimeRemotePluginDir = join(
      workspace,
      "stale-runtime-remote-plugin",
    );
    const mismatchedRuntimeRemotePluginCountDir = join(
      workspace,
      "mismatched-runtime-remote-plugin-count",
    );
    const missingRegisteredServiceDir = join(
      workspace,
      "missing-registered-service",
    );
    const missingEvaluatorDir = join(workspace, "missing-evaluator");
    const missingEventDir = join(workspace, "missing-event");
    const missingServiceDir = join(workspace, "missing-service");
    const missingAppDir = join(workspace, "missing-app");
    const missingFieldEvaluatorDir = join(workspace, "missing-field-evaluator");
    await mkdir(completeDir, { recursive: true });
    await mkdir(completeExtraExercisesDir, { recursive: true });
    await mkdir(completePartialModuleDir, { recursive: true });
    await mkdir(cloudOnlyDir, { recursive: true });
    await mkdir(ciDir, { recursive: true });
    await mkdir(providerCiDir, { recursive: true });
    await mkdir(malformedCiDir, { recursive: true });
    await mkdir(pushCiDir, { recursive: true });
    await mkdir(providerOnlyDir, { recursive: true });
    await mkdir(requiredProvidersDir, { recursive: true });
    await mkdir(threeProvidersDir, { recursive: true });
    await mkdir(expectedCountDir, { recursive: true });
    await mkdir(unknownProviderDir, { recursive: true });
    await mkdir(freshDir, { recursive: true });
    await mkdir(staleDir, { recursive: true });
    await mkdir(nearFutureDir, { recursive: true });
    await mkdir(farFutureDir, { recursive: true });
    await mkdir(malformedObservedAtDir, { recursive: true });
    await mkdir(wrongSchemaDir, { recursive: true });
    await mkdir(partialDir, { recursive: true });
    await mkdir(failedRouteDir, { recursive: true });
    await mkdir(missingRouteBodyDir, { recursive: true });
    await mkdir(emptyRouteBodyDir, { recursive: true });
    await mkdir(missingModelResultDir, { recursive: true });
    await mkdir(emptyActionResultDir, { recursive: true });
    await mkdir(emptyProviderResultDir, { recursive: true });
    await mkdir(failedLifecycleDir, { recursive: true });
    await mkdir(unhandledEventDir, { recursive: true });
    await mkdir(missingServiceResultDir, { recursive: true });
    await mkdir(missingAppBridgeResultDir, { recursive: true });
    await mkdir(emptyEvaluatorProcessDir, { recursive: true });
    await mkdir(emptyResponseHandlerEvaluateDir, { recursive: true });
    await mkdir(emptyFieldEvaluatorParseDir, { recursive: true });
    await mkdir(emptyFieldEvaluatorHandleDir, { recursive: true });
    await mkdir(nonJavascriptAssetDir, { recursive: true });
    await mkdir(mismatchedAssetManifestDir, { recursive: true });
    await mkdir(mismatchedAssetIntegrityDir, { recursive: true });
    await mkdir(missingSha256AssetIntegrityDir, { recursive: true });
    await mkdir(missingAssetDigestDir, { recursive: true });
    await mkdir(malformedAssetDigestDir, { recursive: true });
    await mkdir(emptyAssetDigestDir, { recursive: true });
    await mkdir(mismatchDir, { recursive: true });
    await mkdir(malformedEndpointIdDir, { recursive: true });
    await mkdir(malformedModuleIdDir, { recursive: true });
    await mkdir(malformedProviderDir, { recursive: true });
    await mkdir(malformedCloudApiBaseDir, { recursive: true });
    await mkdir(cloudProviderFieldDir, { recursive: true });
    await mkdir(providerCloudFieldDir, { recursive: true });
    await mkdir(cloudApiBaseQueryDir, { recursive: true });
    await mkdir(cloudApiBaseFragmentDir, { recursive: true });
    await mkdir(matchingFileIdentityDir, { recursive: true });
    await mkdir(mismatchedFileIdentityDir, { recursive: true });
    await mkdir(mismatchedCloudFileIdentityDir, { recursive: true });
    await mkdir(duplicateEndpointDir, { recursive: true });
    await mkdir(duplicateProviderDir, { recursive: true });
    await mkdir(duplicateEndpointUrlFingerprintDir, { recursive: true });
    await mkdir(missingProviderIdDir, { recursive: true });
    await mkdir(mismatchedProviderIdDir, { recursive: true });
    await mkdir(missingProviderEvidenceDir, { recursive: true });
    await mkdir(mismatchedProviderEvidenceDir, { recursive: true });
    await mkdir(missingEndpointUrlFingerprintDir, { recursive: true });
    await mkdir(malformedEndpointUrlFingerprintDir, { recursive: true });
    await mkdir(leakedSecretDir, { recursive: true });
    await mkdir(leakedSecretValueDir, { recursive: true });
    await mkdir(bogusTargetDir, { recursive: true });
    await mkdir(malformedTargetDir, { recursive: true });
    await mkdir(bogusTrustDir, { recursive: true });
    await mkdir(bogusRegistrationDir, { recursive: true });
    await mkdir(duplicateModuleDir, { recursive: true });
    await mkdir(duplicateRegisteredModuleDir, { recursive: true });
    await mkdir(duplicateRegisteredPluginDir, { recursive: true });
    await mkdir(duplicateTrustDecisionDir, { recursive: true });
    await mkdir(registeredSkippedDir, { recursive: true });
    await mkdir(registeredUnloadedDir, { recursive: true });
    await mkdir(skippedUnloadedOverlapDir, { recursive: true });
    await mkdir(skippedMissingTrustDir, { recursive: true });
    await mkdir(duplicateSkippedDir, { recursive: true });
    await mkdir(duplicateUnloadedDir, { recursive: true });
    await mkdir(exercisedUnregisteredDir, { recursive: true });
    await mkdir(registeredUnexercisedDir, { recursive: true });
    await mkdir(missingSummaryModuleExerciseDir, { recursive: true });
    await mkdir(duplicateModuleExerciseDir, { recursive: true });
    await mkdir(missingModuleExercisesDir, { recursive: true });
    await mkdir(missingRpcCallsDir, { recursive: true });
    await mkdir(invalidRpcMethodDir, { recursive: true });
    await mkdir(missingRequiredRpcMethodDir, { recursive: true });
    await mkdir(manifestOnlyUnregisteredDir, { recursive: true });
    await mkdir(runtimeUndercountDir, { recursive: true });
    await mkdir(runtimePluginUndercountDir, { recursive: true });
    await mkdir(missingRuntimeRemotePluginDir, { recursive: true });
    await mkdir(staleRuntimeRemotePluginDir, { recursive: true });
    await mkdir(mismatchedRuntimeRemotePluginCountDir, { recursive: true });
    await mkdir(missingRegisteredServiceDir, { recursive: true });
    await mkdir(missingEvaluatorDir, { recursive: true });
    await mkdir(missingEventDir, { recursive: true });
    await mkdir(missingServiceDir, { recursive: true });
    await mkdir(missingAppDir, { recursive: true });
    await mkdir(missingFieldEvaluatorDir, { recursive: true });
    await writeFile(
      join(completeDir, "cloud.json"),
      `${JSON.stringify(makeCompleteReport("cloud", "sample-cloud-endpoint"), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(completeDir, "provider.json"),
      `${JSON.stringify(makeCompleteReport("provider"), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(completeExtraExercisesDir, "provider.json"),
      `${JSON.stringify(makeCompleteExtraExercisesReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(completePartialModuleDir, "provider.json"),
      `${JSON.stringify(makeCompletePartialModuleReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(cloudOnlyDir, "cloud.json"),
      `${JSON.stringify(makeCompleteReport("cloud", "sample-cloud-endpoint"), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(ciDir, "cloud.json"),
      `${JSON.stringify(makeCiReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(providerCiDir, "provider.json"),
      `${JSON.stringify(makeProviderCiReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(malformedCiDir, "cloud.json"),
      `${JSON.stringify(makeMalformedCiReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(pushCiDir, "cloud.json"),
      `${JSON.stringify(makePushCiReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(providerOnlyDir, "provider.json"),
      `${JSON.stringify(makeCompleteReport("provider"), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(requiredProvidersDir, "home-machine.json"),
      `${JSON.stringify(makeCompleteReport("provider", "required-home-endpoint", "home-machine"), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(requiredProvidersDir, "mobile-companion.json"),
      `${JSON.stringify(makeCompleteReport("provider", "required-mobile-endpoint", "mobile-companion"), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(threeProvidersDir, "home-machine.json"),
      `${JSON.stringify(makeCompleteReport("provider", "three-home-endpoint", "home-machine"), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(threeProvidersDir, "mobile-companion.json"),
      `${JSON.stringify(makeCompleteReport("provider", "three-mobile-endpoint", "mobile-companion"), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(threeProvidersDir, "desktop-companion.json"),
      `${JSON.stringify(makeCompleteReport("provider", "three-desktop-endpoint", "desktop-companion"), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(expectedCountDir, "cloud-a.json"),
      `${JSON.stringify(makeCompleteReport("cloud", "expected-cloud-a"), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(expectedCountDir, "cloud-b.json"),
      `${JSON.stringify(makeCompleteReport("cloud", "expected-cloud-b"), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(unknownProviderDir, "provider.json"),
      `${JSON.stringify(makeCompleteReport("provider", "unknown-provider-endpoint", "unknown-provider"), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(freshDir, "provider.json"),
      `${JSON.stringify(makeCompleteReport("provider", "fresh-endpoint", "home-machine", new Date().toISOString()), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(staleDir, "provider.json"),
      `${JSON.stringify(makeCompleteReport("provider", "stale-endpoint"), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(nearFutureDir, "provider.json"),
      `${JSON.stringify(makeCompleteReport("provider", "near-future-endpoint", "home-machine", new Date(Date.now() + 60_000).toISOString()), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(farFutureDir, "provider.json"),
      `${JSON.stringify(makeCompleteReport("provider", "far-future-endpoint", "home-machine", new Date(Date.now() + 10 * 60_000).toISOString()), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(malformedObservedAtDir, "provider.json"),
      `${JSON.stringify(makeCompleteReport("provider", "malformed-observed-at-endpoint", "home-machine", "not-a-timestamp"), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(wrongSchemaDir, "provider.json"),
      `${JSON.stringify(makeWrongSchemaReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(partialDir, "provider.json"),
      `${JSON.stringify(makePartialReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(failedRouteDir, "provider.json"),
      `${JSON.stringify(makeFailedRouteReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(missingRouteBodyDir, "provider.json"),
      `${JSON.stringify(makeMissingRouteBodyReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(emptyRouteBodyDir, "provider.json"),
      `${JSON.stringify(makeEmptyRouteBodyReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(nonJavascriptAssetDir, "provider.json"),
      `${JSON.stringify(makeNonJavascriptAssetReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(mismatchedAssetManifestDir, "provider.json"),
      `${JSON.stringify(makeMismatchedAssetManifestReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(mismatchedAssetIntegrityDir, "provider.json"),
      `${JSON.stringify(makeMismatchedAssetIntegrityReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(missingSha256AssetIntegrityDir, "provider.json"),
      `${JSON.stringify(makeMissingSha256AssetIntegrityReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(missingAssetDigestDir, "provider.json"),
      `${JSON.stringify(makeMissingAssetDigestReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(malformedAssetDigestDir, "provider.json"),
      `${JSON.stringify(makeMalformedAssetDigestReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(emptyAssetDigestDir, "provider.json"),
      `${JSON.stringify(makeEmptyAssetDigestReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(missingModelResultDir, "provider.json"),
      `${JSON.stringify(makeMissingModelResultReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(emptyActionResultDir, "provider.json"),
      `${JSON.stringify(makeEmptyActionResultReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(emptyProviderResultDir, "provider.json"),
      `${JSON.stringify(makeEmptyProviderResultReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(failedLifecycleDir, "provider.json"),
      `${JSON.stringify(makeFailedLifecycleReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(unhandledEventDir, "provider.json"),
      `${JSON.stringify(makeUnhandledEventReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(missingServiceResultDir, "provider.json"),
      `${JSON.stringify(makeMissingServiceResultReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(missingAppBridgeResultDir, "provider.json"),
      `${JSON.stringify(makeMissingAppBridgeResultReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(emptyEvaluatorProcessDir, "provider.json"),
      `${JSON.stringify(makeEmptyEvaluatorProcessReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(emptyResponseHandlerEvaluateDir, "provider.json"),
      `${JSON.stringify(makeEmptyResponseHandlerEvaluateReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(emptyFieldEvaluatorParseDir, "provider.json"),
      `${JSON.stringify(makeEmptyFieldEvaluatorParseReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(emptyFieldEvaluatorHandleDir, "provider.json"),
      `${JSON.stringify(makeEmptyFieldEvaluatorHandleReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(mismatchDir, "provider.json"),
      `${JSON.stringify(makeEndpointMismatchReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(malformedEndpointIdDir, "provider.json"),
      `${JSON.stringify(makeMalformedEndpointIdReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(malformedModuleIdDir, "provider.json"),
      `${JSON.stringify(makeMalformedModuleIdReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(malformedProviderDir, "provider.json"),
      `${JSON.stringify(makeMalformedProviderReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(malformedCloudApiBaseDir, "cloud.json"),
      `${JSON.stringify(makeMalformedCloudApiBaseReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(cloudProviderFieldDir, "cloud.json"),
      `${JSON.stringify(makeCloudProviderFieldReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(providerCloudFieldDir, "provider.json"),
      `${JSON.stringify(makeProviderCloudFieldReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(cloudApiBaseQueryDir, "cloud.json"),
      `${JSON.stringify(makeCloudApiBaseQueryReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(cloudApiBaseFragmentDir, "cloud.json"),
      `${JSON.stringify(makeCloudApiBaseFragmentReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(matchingFileIdentityDir, "home-machine.json"),
      `${JSON.stringify(makeCompleteReport("provider", "matching-file-endpoint", "home-machine"), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(mismatchedFileIdentityDir, "home-machine.json"),
      `${JSON.stringify(makeCompleteReport("provider", "mismatched-file-endpoint", "mobile-companion"), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(mismatchedCloudFileIdentityDir, "cloud-live.json"),
      `${JSON.stringify(makeCompleteReport("cloud", "mismatched-cloud-file-endpoint"), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(duplicateEndpointDir, "provider-a.json"),
      `${JSON.stringify(makeCompleteReport("provider", "shared-endpoint", "home-machine"), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(duplicateEndpointDir, "provider-b.json"),
      `${JSON.stringify(makeCompleteReport("provider", "shared-endpoint", "mobile-companion"), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(duplicateProviderDir, "provider-a.json"),
      `${JSON.stringify(makeCompleteReport("provider", "provider-endpoint-a", "home-machine"), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(duplicateProviderDir, "provider-b.json"),
      `${JSON.stringify(makeCompleteReport("provider", "provider-endpoint-b", "home-machine"), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(duplicateEndpointUrlFingerprintDir, "provider-a.json"),
      `${JSON.stringify(makeCompleteReport("provider", "fingerprint-endpoint-a", "home-machine"), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(duplicateEndpointUrlFingerprintDir, "provider-b.json"),
      `${JSON.stringify(
        {
          ...makeCompleteReport(
            "provider",
            "fingerprint-endpoint-b",
            "home-machine",
          ),
          endpointUrlSha256: makeEndpointUrlSha256(
            "fingerprint-endpoint-a",
            "home-machine",
          ),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeFile(
      join(missingProviderIdDir, "provider.json"),
      `${JSON.stringify(makeMissingProviderIdReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(mismatchedProviderIdDir, "provider.json"),
      `${JSON.stringify(makeMismatchedProviderIdReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(missingProviderEvidenceDir, "provider.json"),
      `${JSON.stringify(makeMissingProviderEvidenceReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(mismatchedProviderEvidenceDir, "provider.json"),
      `${JSON.stringify(makeMismatchedProviderEvidenceReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(missingEndpointUrlFingerprintDir, "provider.json"),
      `${JSON.stringify(makeMissingEndpointUrlFingerprintReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(malformedEndpointUrlFingerprintDir, "provider.json"),
      `${JSON.stringify(makeMalformedEndpointUrlFingerprintReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(leakedSecretDir, "provider.json"),
      `${JSON.stringify(makeLeakedSecretReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(leakedSecretValueDir, "provider.json"),
      `${JSON.stringify(makeLeakedSecretValueReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(bogusTargetDir, "provider.json"),
      `${JSON.stringify(makeBogusExercisedTargetReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(malformedTargetDir, "provider.json"),
      `${JSON.stringify(makeMalformedExercisedTargetReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(bogusTrustDir, "provider.json"),
      `${JSON.stringify(makeBogusTrustReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(bogusRegistrationDir, "provider.json"),
      `${JSON.stringify(makeBogusRegistrationReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(duplicateModuleDir, "provider.json"),
      `${JSON.stringify(makeDuplicateModuleReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(duplicateRegisteredModuleDir, "provider.json"),
      `${JSON.stringify(makeDuplicateRegisteredModuleReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(duplicateRegisteredPluginDir, "provider.json"),
      `${JSON.stringify(makeDuplicateRegisteredPluginReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(duplicateTrustDecisionDir, "provider.json"),
      `${JSON.stringify(makeDuplicateTrustDecisionReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(registeredSkippedDir, "provider.json"),
      `${JSON.stringify(makeRegisteredSkippedReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(registeredUnloadedDir, "provider.json"),
      `${JSON.stringify(makeRegisteredUnloadedReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(skippedUnloadedOverlapDir, "provider.json"),
      `${JSON.stringify(makeSkippedUnloadedOverlapReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(skippedMissingTrustDir, "provider.json"),
      `${JSON.stringify(makeSkippedMissingTrustReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(duplicateSkippedDir, "provider.json"),
      `${JSON.stringify(makeDuplicateSkippedReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(duplicateUnloadedDir, "provider.json"),
      `${JSON.stringify(makeDuplicateUnloadedReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(exercisedUnregisteredDir, "provider.json"),
      `${JSON.stringify(makeExercisedUnregisteredReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(registeredUnexercisedDir, "provider.json"),
      `${JSON.stringify(makeRegisteredUnexercisedReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(missingSummaryModuleExerciseDir, "provider.json"),
      `${JSON.stringify(makeMissingSummaryModuleExerciseReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(duplicateModuleExerciseDir, "provider.json"),
      `${JSON.stringify(makeDuplicateModuleExerciseReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(missingModuleExercisesDir, "provider.json"),
      `${JSON.stringify(makeMissingModuleExercisesReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(missingRuntimeRemotePluginDir, "provider.json"),
      `${JSON.stringify(makeMissingRuntimeRemotePluginReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(staleRuntimeRemotePluginDir, "provider.json"),
      `${JSON.stringify(makeStaleRuntimeRemotePluginReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(missingRpcCallsDir, "provider.json"),
      `${JSON.stringify(makeMissingRpcCallsReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(invalidRpcMethodDir, "provider.json"),
      `${JSON.stringify(makeInvalidRpcMethodReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(missingRequiredRpcMethodDir, "provider.json"),
      `${JSON.stringify(makeMissingRequiredRpcMethodReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(manifestOnlyUnregisteredDir, "provider.json"),
      `${JSON.stringify(makeManifestOnlyUnregisteredReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(runtimeUndercountDir, "provider.json"),
      `${JSON.stringify(makeRuntimeUndercountReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(runtimePluginUndercountDir, "provider.json"),
      `${JSON.stringify(makeRuntimePluginUndercountReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(mismatchedRuntimeRemotePluginCountDir, "provider.json"),
      `${JSON.stringify(makeMismatchedRuntimeRemotePluginCountReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(missingRegisteredServiceDir, "provider.json"),
      `${JSON.stringify(makeMissingRegisteredServiceReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(missingEvaluatorDir, "provider.json"),
      `${JSON.stringify(makeMissingEvaluatorMaterializationReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(missingEventDir, "provider.json"),
      `${JSON.stringify(makeMissingEventMaterializationReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(missingServiceDir, "provider.json"),
      `${JSON.stringify(makeMissingServiceMaterializationReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(missingAppDir, "provider.json"),
      `${JSON.stringify(makeMissingAppMaterializationReport(), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(missingFieldEvaluatorDir, "provider.json"),
      `${JSON.stringify(makeMissingFieldEvaluatorMaterializationReport(), null, 2)}\n`,
      "utf8",
    );

    const complete = await runValidator(completeDir);
    if (complete.exitCode !== 0) {
      throw new Error(
        `complete reports should validate, got ${complete.exitCode}: ${complete.output}`,
      );
    }
    const completeExtraExercises = await runValidator(
      completeExtraExercisesDir,
    );
    if (completeExtraExercises.exitCode !== 0) {
      throw new Error(
        `complete extra exercise reports should validate, got ${completeExtraExercises.exitCode}: ${completeExtraExercises.output}`,
      );
    }
    const completePartialModule = await runValidator(completePartialModuleDir);
    if (completePartialModule.exitCode !== 0) {
      throw new Error(
        `complete partial module reports should validate, got ${completePartialModule.exitCode}: ${completePartialModule.output}`,
      );
    }
    const cloudKind = await runValidator(cloudOnlyDir, "--kind", "cloud");
    if (cloudKind.exitCode !== 0) {
      throw new Error(
        `cloud kind reports should validate, got ${cloudKind.exitCode}: ${cloudKind.output}`,
      );
    }
    const cloudCount = await runValidator(
      cloudOnlyDir,
      "--kind=cloud",
      "--expect-count",
      "1",
    );
    if (cloudCount.exitCode !== 0) {
      throw new Error(
        `cloud count report should validate, got ${cloudCount.exitCode}: ${cloudCount.output}`,
      );
    }
    const wrongCloudCount = await runValidator(
      expectedCountDir,
      "--kind=cloud",
      "--expect-count=1",
    );
    assertRejected(
      wrongCloudCount,
      "expected 1 report(s), got 2",
      "wrongCloudCount",
    );
    const ci = await runValidator(ciDir, "--kind=cloud", "--require-ci");
    if (ci.exitCode !== 0) {
      throw new Error(
        `ci report should validate, got ${ci.exitCode}: ${ci.output}`,
      );
    }
    const providerCi = await runValidator(
      providerCiDir,
      "--kind=provider",
      "--require-ci",
    );
    if (providerCi.exitCode !== 0) {
      throw new Error(
        `provider ci report should validate, got ${providerCi.exitCode}: ${providerCi.output}`,
      );
    }
    const matchedCi = await runValidator(
      ciDir,
      "--kind=cloud",
      "--match-github-env",
      {
        GITHUB_RUN_ID: "123456",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_WORKFLOW: "Tests",
        GITHUB_EVENT_NAME: "workflow_dispatch",
        GITHUB_REPOSITORY: "elizaOS/eliza",
        GITHUB_SHA: "0123456789abcdef0123456789abcdef01234567",
        GITHUB_REF: "refs/heads/main",
      },
    );
    if (matchedCi.exitCode !== 0) {
      throw new Error(
        `matched ci report should validate, got ${matchedCi.exitCode}: ${matchedCi.output}`,
      );
    }
    const matchedProviderCi = await runValidator(
      providerCiDir,
      "--kind=provider",
      "--match-github-env",
      {
        GITHUB_RUN_ID: "654321",
        GITHUB_RUN_ATTEMPT: "2",
        GITHUB_WORKFLOW: "Tests",
        GITHUB_EVENT_NAME: "schedule",
        GITHUB_REPOSITORY: "elizaOS/eliza",
        GITHUB_SHA: "89abcdef0123456789abcdef0123456789abcdef",
        GITHUB_REF: "refs/heads/main",
      },
    );
    if (matchedProviderCi.exitCode !== 0) {
      throw new Error(
        `matched provider ci report should validate, got ${matchedProviderCi.exitCode}: ${matchedProviderCi.output}`,
      );
    }
    const mismatchedProviderCi = await runValidator(
      providerCiDir,
      "--kind=provider",
      "--match-github-env",
      {
        GITHUB_RUN_ID: "654321",
        GITHUB_RUN_ATTEMPT: "3",
        GITHUB_WORKFLOW: "Tests",
        GITHUB_EVENT_NAME: "schedule",
        GITHUB_REPOSITORY: "elizaOS/eliza",
        GITHUB_SHA: "89abcdef0123456789abcdef0123456789abcdef",
        GITHUB_REF: "refs/heads/main",
      },
    );
    assertRejected(
      mismatchedProviderCi,
      "ci.runAttempt must match GITHUB_RUN_ATTEMPT",
      "mismatchedProviderCi",
    );
    const mismatchedCi = await runValidator(
      ciDir,
      "--kind=cloud",
      "--match-github-env",
      {
        GITHUB_RUN_ID: "999999",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_WORKFLOW: "Tests",
        GITHUB_EVENT_NAME: "workflow_dispatch",
        GITHUB_REPOSITORY: "elizaOS/eliza",
        GITHUB_SHA: "0123456789abcdef0123456789abcdef01234567",
        GITHUB_REF: "refs/heads/main",
      },
    );
    assertRejected(
      mismatchedCi,
      "ci.runId must match GITHUB_RUN_ID",
      "mismatchedCi",
    );
    const missingGithubEnv = await runValidator(
      ciDir,
      "--kind=cloud",
      "--match-github-env",
      {
        GITHUB_RUN_ID: "123456",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_WORKFLOW: "Tests",
        GITHUB_EVENT_NAME: "workflow_dispatch",
        GITHUB_REPOSITORY: "elizaOS/eliza",
        GITHUB_SHA: "0123456789abcdef0123456789abcdef01234567",
        GITHUB_REF: "",
      },
    );
    assertRejected(
      missingGithubEnv,
      "GITHUB_REF must be set",
      "missingGithubEnv",
    );
    const malformedCi = await runValidator(
      malformedCiDir,
      "--kind=cloud",
      "--require-ci",
    );
    assertRejected(malformedCi, "ci.sha has invalid format", "malformedCi");
    const pushCi = await runValidator(
      pushCiDir,
      "--kind=cloud",
      "--require-ci",
    );
    assertRejected(
      pushCi,
      "ci.eventName must be workflow_dispatch or schedule",
      "pushCi",
    );
    const missingCi = await runValidator(
      cloudOnlyDir,
      "--kind=cloud",
      "--require-ci",
    );
    assertRejected(missingCi, "ci must be an object", "missingCi");
    const providerKind = await runValidator(providerOnlyDir, "--kind=provider");
    if (providerKind.exitCode !== 0) {
      throw new Error(
        `provider kind reports should validate, got ${providerKind.exitCode}: ${providerKind.output}`,
      );
    }
    const requiredProviders = await runValidator(
      requiredProvidersDir,
      "--kind=provider",
      "--expect-count=2..3",
      "--require-providers",
      "home-machine,mobile-companion",
    );
    if (requiredProviders.exitCode !== 0) {
      throw new Error(
        `required provider reports should validate, got ${requiredProviders.exitCode}: ${requiredProviders.output}`,
      );
    }
    const threeProviders = await runValidator(
      threeProvidersDir,
      "--kind=provider",
      "--expect-count=2..3",
      "--allowed-providers=home-machine,mobile-companion,desktop-companion",
      "--require-providers=home-machine,mobile-companion",
    );
    if (threeProviders.exitCode !== 0) {
      throw new Error(
        `three provider reports should validate, got ${threeProviders.exitCode}: ${threeProviders.output}`,
      );
    }
    const missingRequiredProvider = await runValidator(
      providerOnlyDir,
      "--kind=provider",
      "--require-providers=home-machine,mobile-companion",
    );
    assertRejected(
      missingRequiredProvider,
      'required provider "mobile-companion" was not observed',
      "missingRequiredProvider",
    );
    const unknownProvider = await runValidator(
      unknownProviderDir,
      "--kind=provider",
      "--allowed-providers=home-machine,mobile-companion,desktop-companion",
    );
    assertRejected(
      unknownProvider,
      "is not in --allowed-providers",
      "unknownProvider",
    );
    const duplicateEndpointUrlFingerprint = await runValidator(
      duplicateEndpointUrlFingerprintDir,
      "--kind=provider",
    );
    assertRejected(
      duplicateEndpointUrlFingerprint,
      "endpointUrlSha256 duplicates",
      "duplicateEndpointUrlFingerprint",
    );
    const missingProviderId = await runValidator(
      missingProviderIdDir,
      "--kind=provider",
    );
    assertRejected(
      missingProviderId,
      "providerId must be a non-empty string",
      "missingProviderId",
    );
    const mismatchedProviderId = await runValidator(
      mismatchedProviderIdDir,
      "--kind=provider",
    );
    assertRejected(
      mismatchedProviderId,
      "providerId must match provider",
      "mismatchedProviderId",
    );
    const missingProviderEvidence = await runValidator(
      missingProviderEvidenceDir,
      "--kind=provider",
    );
    assertRejected(
      missingProviderEvidence,
      "providerEvidence must be an object",
      "missingProviderEvidence",
    );
    const mismatchedProviderEvidence = await runValidator(
      mismatchedProviderEvidenceDir,
      "--kind=provider",
    );
    assertRejected(
      mismatchedProviderEvidence,
      'providerEvidence.endpointRuntime must be "mobile-companion"',
      "mismatchedProviderEvidence",
    );
    const missingEndpointUrlFingerprint = await runValidator(
      missingEndpointUrlFingerprintDir,
      "--kind=provider",
    );
    assertRejected(
      missingEndpointUrlFingerprint,
      "endpointUrlSha256 must be a non-empty string",
      "missingEndpointUrlFingerprint",
    );
    const malformedEndpointUrlFingerprint = await runValidator(
      malformedEndpointUrlFingerprintDir,
      "--kind=provider",
    );
    assertRejected(
      malformedEndpointUrlFingerprint,
      "endpointUrlSha256 has invalid format",
      "malformedEndpointUrlFingerprint",
    );
    const kindMismatch = await runValidator(providerOnlyDir, "--kind", "cloud");
    assertRejected(kindMismatch, 'kind must be "cloud"', "kindMismatch");
    const fresh = await runValidator(
      freshDir,
      "--kind=provider",
      "--max-age-minutes",
      "5",
    );
    if (fresh.exitCode !== 0) {
      throw new Error(
        `fresh report should validate, got ${fresh.exitCode}: ${fresh.output}`,
      );
    }
    const stale = await runValidator(
      staleDir,
      "--kind=provider",
      "--max-age-minutes=5",
    );
    assertRejected(stale, "observedAt is older", "stale");
    const nearFuture = await runValidator(
      nearFutureDir,
      "--kind=provider",
      "--max-future-minutes",
      "5",
    );
    if (nearFuture.exitCode !== 0) {
      throw new Error(
        `near-future report should validate, got ${nearFuture.exitCode}: ${nearFuture.output}`,
      );
    }
    const farFuture = await runValidator(
      farFutureDir,
      "--kind=provider",
      "--max-future-minutes=5",
    );
    assertRejected(farFuture, "observedAt is newer", "farFuture");
    const malformedObservedAt = await runValidator(malformedObservedAtDir);
    assertRejected(
      malformedObservedAt,
      "observedAt must be an ISO timestamp",
      "malformedObservedAt",
    );
    const wrongSchema = await runValidator(wrongSchemaDir);
    assertRejected(wrongSchema, "schemaVersion must be 1", "wrongSchema");
    const partial = await runValidator(partialDir);
    assertRejected(partial, "conformance.exercised.provider", "partial");
    const failedRoute = await runValidator(failedRouteDir);
    assertRejected(
      failedRoute,
      "conformance.routeResult.status must be a 2xx HTTP status",
      "failedRoute",
    );
    const missingRouteBody = await runValidator(missingRouteBodyDir);
    assertRejected(
      missingRouteBody,
      "conformance.routeResult.body must be a non-empty JSON value",
      "missingRouteBody",
    );
    const emptyRouteBody = await runValidator(emptyRouteBodyDir);
    assertRejected(
      emptyRouteBody,
      "conformance.routeResult.body must be a non-empty JSON value",
      "emptyRouteBody",
    );
    const nonJavascriptAsset = await runValidator(nonJavascriptAssetDir);
    assertRejected(
      nonJavascriptAsset,
      "conformance.assetResult.path must be a JavaScript asset",
      "nonJavascriptAsset",
    );
    const mismatchedAssetManifest = await runValidator(
      mismatchedAssetManifestDir,
    );
    assertRejected(
      mismatchedAssetManifest,
      "conformance.assetResult.manifestContentType must match",
      "mismatchedAssetManifest",
    );
    const mismatchedAssetIntegrity = await runValidator(
      mismatchedAssetIntegrityDir,
    );
    assertRejected(
      mismatchedAssetIntegrity,
      "conformance.assetResult.integrity must match conformance.assetResult.sha256",
      "mismatchedAssetIntegrity",
    );
    const missingSha256AssetIntegrity = await runValidator(
      missingSha256AssetIntegrityDir,
    );
    assertRejected(
      missingSha256AssetIntegrity,
      "conformance.assetResult.integrity must include a sha256 digest",
      "missingSha256AssetIntegrity",
    );
    const missingAssetDigest = await runValidator(missingAssetDigestDir);
    assertRejected(
      missingAssetDigest,
      "conformance.assetResult.sha256 must be a non-empty string",
      "missingAssetDigest",
    );
    const malformedAssetDigest = await runValidator(malformedAssetDigestDir);
    assertRejected(
      malformedAssetDigest,
      "conformance.assetResult.sha256 has invalid format",
      "malformedAssetDigest",
    );
    const emptyAssetDigest = await runValidator(emptyAssetDigestDir);
    assertRejected(
      emptyAssetDigest,
      "conformance.assetResult.sha256 must not be the empty SHA-256 digest",
      "emptyAssetDigest",
    );
    const missingModelResult = await runValidator(missingModelResultDir);
    assertRejected(
      missingModelResult,
      "conformance.modelResult.result is required",
      "missingModelResult",
    );
    const emptyActionResult = await runValidator(emptyActionResultDir);
    assertRejected(
      emptyActionResult,
      "conformance.actionResult must include at least one result field",
      "emptyActionResult",
    );
    const emptyProviderResult = await runValidator(emptyProviderResultDir);
    assertRejected(
      emptyProviderResult,
      "conformance.providerResult must include at least one result field",
      "emptyProviderResult",
    );
    const failedLifecycle = await runValidator(failedLifecycleDir);
    assertRejected(
      failedLifecycle,
      "conformance.lifecycleResult.ok must be true",
      "failedLifecycle",
    );
    const unhandledEvent = await runValidator(unhandledEventDir);
    assertRejected(
      unhandledEvent,
      "conformance.eventResult.handled must be true",
      "unhandledEvent",
    );
    const missingServiceResult = await runValidator(missingServiceResultDir);
    assertRejected(
      missingServiceResult,
      "conformance.serviceResult.result is required",
      "missingServiceResult",
    );
    const missingAppBridgeResult = await runValidator(
      missingAppBridgeResultDir,
    );
    assertRejected(
      missingAppBridgeResult,
      "conformance.appBridgeResult.result is required",
      "missingAppBridgeResult",
    );
    const emptyEvaluatorProcess = await runValidator(emptyEvaluatorProcessDir);
    assertRejected(
      emptyEvaluatorProcess,
      "conformance.evaluatorResult.process.result is required",
      "emptyEvaluatorProcess",
    );
    const emptyResponseHandlerEvaluate = await runValidator(
      emptyResponseHandlerEvaluateDir,
    );
    assertRejected(
      emptyResponseHandlerEvaluate,
      "conformance.responseHandlerEvaluatorResult.evaluate.patch is required",
      "emptyResponseHandlerEvaluate",
    );
    const emptyFieldEvaluatorParse = await runValidator(
      emptyFieldEvaluatorParseDir,
    );
    assertRejected(
      emptyFieldEvaluatorParse,
      "conformance.responseHandlerFieldEvaluatorResult.parse must include at least one result field",
      "emptyFieldEvaluatorParse",
    );
    const emptyFieldEvaluatorHandle = await runValidator(
      emptyFieldEvaluatorHandleDir,
    );
    assertRejected(
      emptyFieldEvaluatorHandle,
      "conformance.responseHandlerFieldEvaluatorResult.handle.effect is required",
      "emptyFieldEvaluatorHandle",
    );
    const mismatch = await runValidator(mismatchDir);
    assertRejected(
      mismatch,
      "conformance.endpointId must match endpointId",
      "mismatch",
    );
    const malformedEndpointId = await runValidator(malformedEndpointIdDir);
    assertRejected(
      malformedEndpointId,
      "endpointId must contain only",
      "malformedEndpointId",
    );
    const malformedModuleId = await runValidator(malformedModuleIdDir);
    assertRejected(
      malformedModuleId,
      "moduleIds[0] must use letters",
      "malformedModuleId",
    );
    const malformedProvider = await runValidator(malformedProviderDir);
    assertRejected(
      malformedProvider,
      "provider must use lowercase",
      "malformedProvider",
    );
    const malformedCloudApiBase = await runValidator(malformedCloudApiBaseDir);
    assertRejected(
      malformedCloudApiBase,
      "cloudApiBase must be an absolute http(s) URL",
      "malformedCloudApiBase",
    );
    const cloudProviderField = await runValidator(cloudProviderFieldDir);
    assertRejected(
      cloudProviderField,
      "provider must not be present for cloud reports",
      "cloudProviderField",
    );
    const providerCloudField = await runValidator(providerCloudFieldDir);
    assertRejected(
      providerCloudField,
      "cloudApiBase must not be present for provider reports",
      "providerCloudField",
    );
    const cloudApiBaseQuery = await runValidator(cloudApiBaseQueryDir);
    assertRejected(
      cloudApiBaseQuery,
      "cloudApiBase must not include query or fragment components",
      "cloudApiBaseQuery",
    );
    const cloudApiBaseFragment = await runValidator(cloudApiBaseFragmentDir);
    assertRejected(
      cloudApiBaseFragment,
      "cloudApiBase must not include query or fragment components",
      "cloudApiBaseFragment",
    );
    const matchingFileIdentity = await runValidator(
      matchingFileIdentityDir,
      "--kind=provider",
      "--require-file-identity",
    );
    if (matchingFileIdentity.exitCode !== 0) {
      throw new Error(
        `matching file identity should validate, got ${matchingFileIdentity.exitCode}: ${matchingFileIdentity.output}`,
      );
    }
    const mismatchedFileIdentity = await runValidator(
      mismatchedFileIdentityDir,
      "--kind=provider",
      "--require-file-identity",
    );
    assertRejected(
      mismatchedFileIdentity,
      "provider report filename must match provider",
      "mismatchedFileIdentity",
    );
    const mismatchedCloudFileIdentity = await runValidator(
      mismatchedCloudFileIdentityDir,
      "--kind=cloud",
      "--require-file-identity",
    );
    assertRejected(
      mismatchedCloudFileIdentity,
      'cloud report filename must be "cloud.json"',
      "mismatchedCloudFileIdentity",
    );
    const duplicateEndpoint = await runValidator(duplicateEndpointDir);
    assertRejected(
      duplicateEndpoint,
      "endpointId duplicates",
      "duplicateEndpoint",
    );
    const duplicateProvider = await runValidator(duplicateProviderDir);
    assertRejected(
      duplicateProvider,
      "provider duplicates",
      "duplicateProvider",
    );
    const leakedSecret = await runValidator(leakedSecretDir);
    assertRejected(leakedSecret, "must not be present", "leakedSecret");
    const leakedSecretValue = await runValidator(leakedSecretValueDir);
    assertRejected(
      leakedSecretValue,
      "credential-shaped string values",
      "leakedSecretValue",
    );
    const bogusTarget = await runValidator(bogusTargetDir);
    assertRejected(
      bogusTarget,
      "must start with an observed module id",
      "bogusTarget",
    );
    const malformedTarget = await runValidator(malformedTargetDir);
    assertRejected(
      malformedTarget,
      "must start with an observed module id followed by",
      "malformedTarget",
    );
    const bogusTrust = await runValidator(bogusTrustDir);
    assertRejected(
      bogusTrust,
      "trusted moduleId must be present",
      "bogusTrust",
    );
    const bogusRegistration = await runValidator(bogusRegistrationDir);
    assertRejected(
      bogusRegistration,
      "trusted module must be present in sync.registeredModules",
      "bogusRegistration",
    );
    const duplicateModule = await runValidator(duplicateModuleDir);
    assertRejected(
      duplicateModule,
      "moduleIds must not contain duplicates",
      "duplicateModule",
    );
    const duplicateRegisteredModule = await runValidator(
      duplicateRegisteredModuleDir,
    );
    assertRejected(
      duplicateRegisteredModule,
      "sync.registeredModules must not contain duplicates",
      "duplicateRegisteredModule",
    );
    const duplicateRegisteredPlugin = await runValidator(
      duplicateRegisteredPluginDir,
    );
    assertRejected(
      duplicateRegisteredPlugin,
      "sync.registered must not contain duplicates",
      "duplicateRegisteredPlugin",
    );
    const duplicateTrustDecision = await runValidator(
      duplicateTrustDecisionDir,
    );
    assertRejected(
      duplicateTrustDecision,
      "sync.trustDecisions must not contain duplicates",
      "duplicateTrustDecision",
    );
    const registeredSkipped = await runValidator(registeredSkippedDir);
    assertRejected(
      registeredSkipped,
      "sync.skipped must not include plugins that are also registered",
      "registeredSkipped",
    );
    const registeredUnloaded = await runValidator(registeredUnloadedDir);
    assertRejected(
      registeredUnloaded,
      "sync.unloaded must not include plugins that are also registered",
      "registeredUnloaded",
    );
    const skippedUnloadedOverlap = await runValidator(
      skippedUnloadedOverlapDir,
    );
    assertRejected(
      skippedUnloadedOverlap,
      "sync.skipped must not include plugins that are also unloaded",
      "skippedUnloadedOverlap",
    );
    const skippedMissingTrust = await runValidator(skippedMissingTrustDir);
    assertRejected(
      skippedMissingTrust,
      "sync.skipped entries must have a rejected sync.trustDecisions entry",
      "skippedMissingTrust",
    );
    const duplicateSkipped = await runValidator(duplicateSkippedDir);
    assertRejected(
      duplicateSkipped,
      "sync.skipped must not contain duplicates",
      "duplicateSkipped",
    );
    const duplicateUnloaded = await runValidator(duplicateUnloadedDir);
    assertRejected(
      duplicateUnloaded,
      "sync.unloaded must not contain duplicates",
      "duplicateUnloaded",
    );
    const exercisedUnregistered = await runValidator(exercisedUnregisteredDir);
    assertRejected(
      exercisedUnregistered,
      "every sync.registeredModules entry must have a trusted sync.trustDecisions entry",
      "exercisedUnregistered",
    );
    const registeredUnexercised = await runValidator(registeredUnexercisedDir);
    assertRejected(
      registeredUnexercised,
      "every sync.registeredModules moduleId must be exercised by conformance.exercised",
      "registeredUnexercised",
    );
    const missingSummaryModuleExercise = await runValidator(
      missingSummaryModuleExerciseDir,
    );
    assertRejected(
      missingSummaryModuleExercise,
      "moduleExercises must include conformance.exercised.action",
      "missingSummaryModuleExercise",
    );
    const duplicateModuleExercise = await runValidator(
      duplicateModuleExerciseDir,
    );
    assertRejected(
      duplicateModuleExercise,
      "conformance.moduleExercises must not contain duplicates",
      "duplicateModuleExercise",
    );
    const missingModuleExercises = await runValidator(
      missingModuleExercisesDir,
    );
    assertRejected(
      missingModuleExercises,
      "conformance.moduleExercises must be an array",
      "missingModuleExercises",
    );
    const missingRpcCalls = await runValidator(missingRpcCallsDir);
    assertRejected(
      missingRpcCalls,
      "conformance.rpcCalls must be an array",
      "missingRpcCalls",
    );
    const invalidRpcMethod = await runValidator(invalidRpcMethodDir);
    assertRejected(
      invalidRpcMethod,
      "conformance.rpcCalls[0].method must be valid for its surface.",
      "invalidRpcMethod",
    );
    const missingRequiredRpcMethod = await runValidator(
      missingRequiredRpcMethodDir,
    );
    assertRejected(
      missingRequiredRpcMethod,
      "conformance.rpcCalls must include every required method for each conformance.moduleExercises entry.",
      "missingRequiredRpcMethod",
    );
    const missingRuntimeRemotePlugin = await runValidator(
      missingRuntimeRemotePluginDir,
    );
    assertRejected(
      missingRuntimeRemotePlugin,
      "runtime.remotePlugins must include every sync.registeredModules entry",
      "missingRuntimeRemotePlugin",
    );
    const staleRuntimeRemotePlugin = await runValidator(
      staleRuntimeRemotePluginDir,
    );
    assertRejected(
      staleRuntimeRemotePlugin,
      "runtime.remotePlugins must not include entries absent from sync.registeredModules",
      "staleRuntimeRemotePlugin",
    );
    const mismatchedRuntimeRemotePluginCount = await runValidator(
      mismatchedRuntimeRemotePluginCountDir,
    );
    assertRejected(
      mismatchedRuntimeRemotePluginCount,
      "runtime.remotePlugins[0].routeCount must match sync.registeredModules",
      "mismatchedRuntimeRemotePluginCount",
    );
    const manifestOnlyUnregistered = await runValidator(
      manifestOnlyUnregisteredDir,
    );
    assertRejected(
      manifestOnlyUnregistered,
      "every conformance.moduleIds entry must be present in sync.registeredModules",
      "manifestOnlyUnregistered",
    );
    const runtimeUndercount = await runValidator(runtimeUndercountDir);
    assertRejected(
      runtimeUndercount,
      "runtime.actionCount",
      "runtimeUndercount",
    );
    const runtimePluginUndercount = await runValidator(
      runtimePluginUndercountDir,
    );
    assertRejected(
      runtimePluginUndercount,
      "runtime.pluginCount",
      "runtimePluginUndercount",
    );
    const missingRegisteredService = await runValidator(
      missingRegisteredServiceDir,
    );
    assertRejected(
      missingRegisteredService,
      "sync.registeredModules aggregate serviceCount must be greater than zero",
      "missingRegisteredService",
    );
    const missingEvaluator = await runValidator(missingEvaluatorDir);
    assertRejected(
      missingEvaluator,
      "runtime.evaluatorCount",
      "missingEvaluator",
    );
    const missingEvent = await runValidator(missingEventDir);
    assertRejected(missingEvent, "runtime.eventCount", "missingEvent");
    const missingService = await runValidator(missingServiceDir);
    assertRejected(missingService, "runtime.serviceCount", "missingService");
    const missingApp = await runValidator(missingAppDir);
    assertRejected(missingApp, "runtime.appCount", "missingApp");
    const missingFieldEvaluator = await runValidator(missingFieldEvaluatorDir);
    assertRejected(
      missingFieldEvaluator,
      "runtime.responseHandlerFieldEvaluatorCount",
      "missingFieldEvaluator",
    );

    console.log("Capability-router live report validator self-test passed.");
  } finally {
    await rm(workspace, { force: true, recursive: true });
  }
}

function makeCompleteReport(
  kind: "cloud" | "provider",
  endpointId = "sample-endpoint",
  provider = "home-machine",
  observedAt = new Date(0).toISOString(),
) {
  const conformance = makeCompleteConformance(endpointId);
  return {
    schemaVersion: 1,
    kind,
    ...(kind === "cloud"
      ? {
          cloudApiBase: "https://api.example.test",
          agentId: "agent-1",
        }
      : {
          provider,
          providerId: provider,
          providerEvidence: makeProviderEvidence(provider),
          endpointUrlSha256: makeEndpointUrlSha256(endpointId, provider),
        }),
    endpointId,
    observedAt,
    conformance,
    sync: {
      registered: ["@remote/sample"],
      registeredModules: [
        {
          pluginName: "@remote/sample",
          moduleId: "sample-module",
          endpointId,
          ...makeRegisteredModuleCounts(),
        },
      ],
      unloaded: [],
      skipped: [],
      trustDecisions: [
        {
          moduleId: "sample-module",
          pluginName: "@remote/sample",
          endpointId,
          trusted: true,
          reason: "allowed",
        },
      ],
    },
    runtime: {
      pluginCount: 1,
      remotePlugins: [
        {
          pluginName: "@remote/sample",
          moduleId: "sample-module",
          endpointId,
          ...makeRegisteredModuleCounts(),
        },
      ],
      actionCount: 1,
      providerCount: 1,
      evaluatorCount: 1,
      responseHandlerEvaluatorCount: 1,
      responseHandlerFieldEvaluatorCount: 1,
      routeCount: 1,
      modelCount: 1,
      eventCount: 1,
      serviceCount: 1,
      appCount: 1,
      appBridgeCount: 1,
      lifecycleCount: 1,
      widgetCount: 1,
      componentTypeCount: 1,
      viewCount: 1,
    },
  };
}

function makeEndpointUrlSha256(endpointId: string, provider: string): string {
  return createHash("sha256")
    .update(`https://${provider}.${endpointId}.example.test`)
    .digest("hex");
}

function makeCompleteExtraExercisesReport() {
  const report = makeCompleteReport("provider");
  return {
    ...report,
    conformance: {
      ...report.conformance,
      moduleCount: 2,
      moduleIds: ["sample-module", "second-module"],
      moduleExercises: [
        ...report.conformance.moduleExercises,
        {
          surface: "action",
          moduleId: "second-module",
          target: "second-module:extra-action",
        },
      ],
      rpcCalls: [
        ...report.conformance.rpcCalls,
        {
          method: "plugin.action.invoke",
          surface: "action",
          moduleId: "second-module",
          target: "second-module:extra-action",
        },
      ],
    },
    sync: {
      ...report.sync,
      registered: ["@remote/sample", "@remote/second"],
      registeredModules: [
        ...report.sync.registeredModules,
        {
          pluginName: "@remote/second",
          moduleId: "second-module",
          endpointId: report.endpointId,
          ...makeRegisteredModuleCounts(),
        },
      ],
      trustDecisions: [
        ...report.sync.trustDecisions,
        {
          moduleId: "second-module",
          pluginName: "@remote/second",
          endpointId: report.endpointId,
          trusted: true,
          reason: "allowed",
        },
      ],
    },
    runtime: {
      pluginCount: 2,
      remotePlugins: [
        ...report.runtime.remotePlugins,
        {
          pluginName: "@remote/second",
          moduleId: "second-module",
          endpointId: report.endpointId,
          ...makeRegisteredModuleCounts(),
        },
      ],
      actionCount: 2,
      providerCount: 2,
      evaluatorCount: 2,
      responseHandlerEvaluatorCount: 2,
      responseHandlerFieldEvaluatorCount: 2,
      routeCount: 2,
      modelCount: 2,
      eventCount: 2,
      serviceCount: 2,
      appCount: 2,
      appBridgeCount: 2,
      lifecycleCount: 2,
      widgetCount: 2,
      componentTypeCount: 2,
      viewCount: 2,
    },
  };
}

function makeCompletePartialModuleReport() {
  const report = makeCompleteReport("provider");
  return {
    ...report,
    conformance: {
      ...report.conformance,
      moduleCount: 2,
      moduleIds: ["sample-module", "partial-module"],
      moduleExercises: [
        ...report.conformance.moduleExercises,
        {
          surface: "action",
          moduleId: "partial-module",
          target: "partial-module:PARTIAL_ACTION",
        },
      ],
      rpcCalls: [
        ...report.conformance.rpcCalls,
        {
          method: "plugin.action.invoke",
          surface: "action",
          moduleId: "partial-module",
          target: "partial-module:PARTIAL_ACTION",
        },
      ],
    },
    sync: {
      ...report.sync,
      registered: ["@remote/sample", "@remote/partial"],
      registeredModules: [
        ...report.sync.registeredModules,
        {
          pluginName: "@remote/partial",
          moduleId: "partial-module",
          endpointId: report.endpointId,
          ...makeRegisteredModuleCounts({
            providerCount: 0,
            evaluatorCount: 0,
            responseHandlerEvaluatorCount: 0,
            responseHandlerFieldEvaluatorCount: 0,
            routeCount: 0,
            modelCount: 0,
            eventCount: 0,
            serviceCount: 0,
            appCount: 0,
            appBridgeCount: 0,
            lifecycleCount: 0,
            widgetCount: 0,
            componentTypeCount: 0,
            viewCount: 0,
          }),
        },
      ],
      trustDecisions: [
        ...report.sync.trustDecisions,
        {
          moduleId: "partial-module",
          pluginName: "@remote/partial",
          endpointId: report.endpointId,
          trusted: true,
          reason: "allowed",
        },
      ],
    },
    runtime: {
      ...report.runtime,
      remotePlugins: [
        ...report.runtime.remotePlugins,
        {
          pluginName: "@remote/partial",
          moduleId: "partial-module",
          endpointId: report.endpointId,
          ...makeRegisteredModuleCounts({
            providerCount: 0,
            evaluatorCount: 0,
            responseHandlerEvaluatorCount: 0,
            responseHandlerFieldEvaluatorCount: 0,
            routeCount: 0,
            modelCount: 0,
            eventCount: 0,
            serviceCount: 0,
            appCount: 0,
            appBridgeCount: 0,
            lifecycleCount: 0,
            widgetCount: 0,
            componentTypeCount: 0,
            viewCount: 0,
          }),
        },
      ],
      pluginCount: 2,
      actionCount: 2,
    },
  };
}

function makeCompleteConformance(endpointId = "sample-endpoint") {
  const exercised = Object.fromEntries(
    [
      "action",
      "provider",
      "route",
      "viewAsset",
      "model",
      "lifecycle",
      "event",
      "service",
      "appBridge",
      "evaluator",
      "responseHandlerEvaluator",
      "responseHandlerFieldEvaluator",
    ].map((surface) => [surface, `sample-module:${surface}`]),
  );
  const moduleExercises = Object.entries(exercised).map(
    ([surface, target]) => ({
      surface,
      moduleId: "sample-module",
      target,
    }),
  );
  const rpcCalls = moduleExercises.flatMap((exercise) =>
    rpcMethodsForSurface(exercise.surface).map((method) => ({
      method,
      ...exercise,
    })),
  );
  return {
    endpointId,
    availability: {
      environment: "server",
      available: true,
      capabilities: {
        fs: false,
        pty: false,
        git: false,
        model: false,
        plugin: true,
      },
    },
    moduleCount: 1,
    moduleIds: ["sample-module"],
    exercised,
    moduleExercises,
    rpcCalls,
    actionResult: { text: "sample action result" },
    providerResult: { text: "sample provider result" },
    routeResult: { status: 200, body: { sampleRoute: true } },
    assetResult: {
      path: "/assets/sample.js",
      contentType: "text/javascript",
      manifestContentType: "text/javascript",
      byteLength: 12,
      sha256:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    },
    modelResult: { result: { text: "sample model result" } },
    lifecycleResult: { ok: true },
    eventResult: { handled: true },
    serviceResult: { result: { text: "sample service result" } },
    appBridgeResult: { result: { handled: true } },
    evaluatorResult: {
      shouldRun: { shouldRun: true },
      prepare: {},
      prompt: { prompt: "sample prompt" },
      process: { result: { text: "sample evaluator result" } },
    },
    responseHandlerEvaluatorResult: {
      shouldRun: { shouldRun: true },
      evaluate: { patch: { text: "sample response patch" } },
    },
    responseHandlerFieldEvaluatorResult: {
      shouldRun: { shouldRun: true },
      parse: { value: { text: "sample parsed field" } },
      handle: { effect: { patch: { text: "sample field patch" } } },
    },
  };
}

function rpcMethodsForSurface(surface: string): string[] {
  switch (surface) {
    case "action":
      return ["plugin.action.invoke"];
    case "provider":
      return ["plugin.provider.get"];
    case "route":
      return ["plugin.route.call"];
    case "viewAsset":
      return ["plugin.asset.get"];
    case "model":
      return ["plugin.model.invoke"];
    case "lifecycle":
      return ["plugin.lifecycle.call"];
    case "event":
      return ["plugin.event.handle"];
    case "service":
      return ["plugin.service.call"];
    case "appBridge":
      return ["plugin.appBridge.call"];
    case "evaluator":
      return [
        "plugin.evaluator.shouldRun",
        "plugin.evaluator.prepare",
        "plugin.evaluator.prompt",
        "plugin.evaluator.process",
      ];
    case "responseHandlerEvaluator":
      return [
        "plugin.responseHandlerEvaluator.shouldRun",
        "plugin.responseHandlerEvaluator.evaluate",
      ];
    case "responseHandlerFieldEvaluator":
      return [
        "plugin.responseHandlerFieldEvaluator.shouldRun",
        "plugin.responseHandlerFieldEvaluator.parse",
        "plugin.responseHandlerFieldEvaluator.handle",
      ];
    default:
      throw new Error(`Unknown surface ${surface}.`);
  }
}

function makePartialReport() {
  return {
    schemaVersion: 1,
    kind: "provider",
    provider: "home-machine",
    providerId: "home-machine",
    providerEvidence: makeProviderEvidence("home-machine"),
    endpointUrlSha256: makeEndpointUrlSha256(
      "partial-endpoint",
      "home-machine",
    ),
    endpointId: "partial-endpoint",
    observedAt: new Date(0).toISOString(),
    conformance: {
      endpointId: "partial-endpoint",
      availability: {
        available: true,
        capabilities: { plugin: true },
      },
      moduleCount: 1,
      moduleIds: ["sample-module"],
      exercised: { action: "sample-module:ACTION" },
    },
  };
}

function makeFailedRouteReport() {
  const report = makeCompleteReport("provider");
  return {
    ...report,
    conformance: {
      ...report.conformance,
      routeResult: { status: 500 },
    },
  };
}

function makeMissingRouteBodyReport() {
  const report = makeCompleteReport("provider");
  return {
    ...report,
    conformance: {
      ...report.conformance,
      routeResult: { status: 204 },
    },
  };
}

function makeEmptyRouteBodyReport() {
  const report = makeCompleteReport("provider");
  return {
    ...report,
    conformance: {
      ...report.conformance,
      routeResult: { status: 200, body: {} },
    },
  };
}

function makeNonJavascriptAssetReport() {
  const report = makeCompleteReport("provider");
  return {
    ...report,
    conformance: {
      ...report.conformance,
      assetResult: {
        path: "/assets/sample.css",
        contentType: "text/css",
        byteLength: 12,
        sha256:
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      },
    },
  };
}

function makeMismatchedAssetManifestReport() {
  const report = makeCompleteReport("provider");
  return {
    ...report,
    conformance: {
      ...report.conformance,
      assetResult: {
        ...report.conformance.assetResult,
        manifestContentType: "application/javascript",
      },
    },
  };
}

function makeMismatchedAssetIntegrityReport() {
  const report = makeCompleteReport("provider");
  return {
    ...report,
    conformance: {
      ...report.conformance,
      assetResult: {
        ...report.conformance.assetResult,
        integrity: "sha256-deadbeef",
        manifestIntegrity: "sha256-deadbeef",
      },
    },
  };
}

function makeMissingSha256AssetIntegrityReport() {
  const report = makeCompleteReport("provider");
  return {
    ...report,
    conformance: {
      ...report.conformance,
      assetResult: {
        ...report.conformance.assetResult,
        integrity: "sha384-deadbeef",
        manifestIntegrity: "sha384-deadbeef",
      },
    },
  };
}

function makeMissingAssetDigestReport() {
  const report = makeCompleteReport("provider");
  return {
    ...report,
    conformance: {
      ...report.conformance,
      assetResult: {
        path: "/assets/sample.js",
        contentType: "text/javascript",
        byteLength: 12,
      },
    },
  };
}

function makeMalformedAssetDigestReport() {
  const report = makeCompleteReport("provider");
  return {
    ...report,
    conformance: {
      ...report.conformance,
      assetResult: {
        path: "/assets/sample.js",
        contentType: "text/javascript",
        byteLength: 12,
        sha256: "not-a-sha",
      },
    },
  };
}

function makeEmptyAssetDigestReport() {
  const report = makeCompleteReport("provider");
  return {
    ...report,
    conformance: {
      ...report.conformance,
      assetResult: {
        ...report.conformance.assetResult,
        sha256:
          "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      },
    },
  };
}

function makeMissingModelResultReport() {
  const report = makeCompleteReport("provider");
  return {
    ...report,
    conformance: {
      ...report.conformance,
      modelResult: {},
    },
  };
}

function makeEmptyActionResultReport() {
  const report = makeCompleteReport("provider");
  return {
    ...report,
    conformance: {
      ...report.conformance,
      actionResult: {},
    },
  };
}

function makeEmptyProviderResultReport() {
  const report = makeCompleteReport("provider");
  return {
    ...report,
    conformance: {
      ...report.conformance,
      providerResult: {},
    },
  };
}

function makeFailedLifecycleReport() {
  const report = makeCompleteReport("provider");
  return {
    ...report,
    conformance: {
      ...report.conformance,
      lifecycleResult: { ok: false },
    },
  };
}

function makeUnhandledEventReport() {
  const report = makeCompleteReport("provider");
  return {
    ...report,
    conformance: {
      ...report.conformance,
      eventResult: { handled: false },
    },
  };
}

function makeMissingServiceResultReport() {
  const report = makeCompleteReport("provider");
  return {
    ...report,
    conformance: {
      ...report.conformance,
      serviceResult: {},
    },
  };
}

function makeMissingAppBridgeResultReport() {
  const report = makeCompleteReport("provider");
  return {
    ...report,
    conformance: {
      ...report.conformance,
      appBridgeResult: {},
    },
  };
}

function makeEmptyEvaluatorProcessReport() {
  const report = makeCompleteReport("provider");
  return {
    ...report,
    conformance: {
      ...report.conformance,
      evaluatorResult: {
        ...report.conformance.evaluatorResult,
        process: {},
      },
    },
  };
}

function makeEmptyResponseHandlerEvaluateReport() {
  const report = makeCompleteReport("provider");
  return {
    ...report,
    conformance: {
      ...report.conformance,
      responseHandlerEvaluatorResult: {
        ...report.conformance.responseHandlerEvaluatorResult,
        evaluate: {},
      },
    },
  };
}

function makeEmptyFieldEvaluatorParseReport() {
  const report = makeCompleteReport("provider");
  return {
    ...report,
    conformance: {
      ...report.conformance,
      responseHandlerFieldEvaluatorResult: {
        ...report.conformance.responseHandlerFieldEvaluatorResult,
        parse: {},
      },
    },
  };
}

function makeEmptyFieldEvaluatorHandleReport() {
  const report = makeCompleteReport("provider");
  return {
    ...report,
    conformance: {
      ...report.conformance,
      responseHandlerFieldEvaluatorResult: {
        ...report.conformance.responseHandlerFieldEvaluatorResult,
        handle: {},
      },
    },
  };
}

function makeCiReport() {
  return {
    ...makeCompleteReport("cloud", "ci-cloud-endpoint"),
    ci: {
      runId: "123456",
      runAttempt: "1",
      workflow: "Tests",
      eventName: "workflow_dispatch",
      repository: "elizaOS/eliza",
      sha: "0123456789abcdef0123456789abcdef01234567",
      ref: "refs/heads/main",
    },
  };
}

function makeProviderCiReport() {
  return {
    ...makeCompleteReport("provider", "ci-provider-endpoint"),
    ci: {
      runId: "654321",
      runAttempt: "2",
      workflow: "Tests",
      eventName: "schedule",
      repository: "elizaOS/eliza",
      sha: "89abcdef0123456789abcdef0123456789abcdef",
      ref: "refs/heads/main",
    },
  };
}

function makeMalformedCiReport() {
  const report = makeCiReport();
  return {
    ...report,
    ci: {
      ...report.ci,
      sha: "not-a-sha",
    },
  };
}

function makePushCiReport() {
  const report = makeCiReport();
  return {
    ...report,
    ci: {
      ...report.ci,
      eventName: "push",
    },
  };
}

function makeWrongSchemaReport() {
  return {
    ...makeCompleteReport("provider"),
    schemaVersion: 0,
  };
}

function makeEndpointMismatchReport() {
  const report = makeCompleteReport("provider");
  return {
    ...report,
    endpointId: "outer-endpoint",
    conformance: {
      ...report.conformance,
      endpointId: "inner-endpoint",
    },
  };
}

function makeMalformedEndpointIdReport() {
  return {
    ...makeCompleteReport("provider"),
    endpointId: "bad endpoint id",
  };
}

function makeMalformedModuleIdReport() {
  const report = makeCompleteReport("provider");
  return {
    ...report,
    conformance: {
      ...report.conformance,
      moduleIds: ["bad:module"],
    },
  };
}

function makeMalformedProviderReport() {
  return {
    ...makeCompleteReport("provider"),
    provider: "Mobile Companion",
  };
}

function makeMalformedCloudApiBaseReport() {
  return {
    ...makeCompleteReport("cloud", "malformed-cloud-endpoint"),
    cloudApiBase: "ftp://api.example.test",
  };
}

function makeCloudProviderFieldReport() {
  return {
    ...makeCompleteReport("cloud", "cloud-provider-field-endpoint"),
    provider: "home-machine",
  };
}

function makeProviderCloudFieldReport() {
  return {
    ...makeCompleteReport(
      "provider",
      "provider-cloud-field-endpoint",
      "home-machine",
    ),
    cloudApiBase: "https://api.example.test",
  };
}

function makeCloudApiBaseQueryReport() {
  return {
    ...makeCompleteReport("cloud", "query-cloud-endpoint"),
    cloudApiBase: "https://api.example.test?debug=true",
  };
}

function makeCloudApiBaseFragmentReport() {
  return {
    ...makeCompleteReport("cloud", "fragment-cloud-endpoint"),
    cloudApiBase: "https://api.example.test#fragment",
  };
}

function makeMissingEndpointUrlFingerprintReport() {
  const report = {
    ...makeCompleteReport(
      "provider",
      "missing-fingerprint-endpoint",
      "home-machine",
    ),
  } as Record<string, unknown>;
  delete report.endpointUrlSha256;
  return report;
}

function makeMissingProviderIdReport() {
  const report = {
    ...makeCompleteReport(
      "provider",
      "missing-provider-id-endpoint",
      "home-machine",
    ),
  } as Record<string, unknown>;
  delete report.providerId;
  return report;
}

function makeMismatchedProviderIdReport() {
  return {
    ...makeCompleteReport(
      "provider",
      "mismatched-provider-id-endpoint",
      "home-machine",
    ),
    providerId: "mobile-companion",
  };
}

function makeMissingProviderEvidenceReport() {
  const report = {
    ...makeCompleteReport(
      "provider",
      "missing-provider-evidence-endpoint",
      "home-machine",
    ),
  } as Record<string, unknown>;
  delete report.providerEvidence;
  return report;
}

function makeMismatchedProviderEvidenceReport() {
  return {
    ...makeCompleteReport(
      "provider",
      "mismatched-provider-evidence-endpoint",
      "mobile-companion",
    ),
    providerEvidence: {
      provider: "mobile-companion",
      endpointRuntime: "home-machine",
      agentRuntime: "github-actions",
      connection: "url-backed-provider",
    },
  };
}

function makeProviderEvidence(provider: string) {
  return {
    provider,
    endpointRuntime: providerEndpointRuntime(provider),
    agentRuntime: "github-actions",
    connection: "url-backed-provider",
  };
}

function providerEndpointRuntime(provider: string): string {
  switch (provider) {
    case "home-machine":
      return "home-machine";
    case "mobile-companion":
      return "mobile-companion";
    case "desktop-companion":
      return "desktop-companion";
    default:
      return `${provider}-endpoint`;
  }
}

function makeMalformedEndpointUrlFingerprintReport() {
  return {
    ...makeCompleteReport(
      "provider",
      "malformed-fingerprint-endpoint",
      "home-machine",
    ),
    endpointUrlSha256: "not-a-sha256-digest",
  };
}

function makeLeakedSecretReport() {
  return {
    ...makeCompleteReport("provider"),
    token: "must-not-upload",
  };
}

function makeLeakedSecretValueReport() {
  return {
    ...makeCompleteReport("provider"),
    diagnostics: {
      request: {
        headers: ["Authorization: Bearer sk-live-report-leak"],
        callbackUrl: "https://user:password@example.test/callback",
      },
    },
  };
}

function makeBogusExercisedTargetReport() {
  const report = makeCompleteReport("provider");
  return {
    ...report,
    conformance: {
      ...report.conformance,
      exercised: {
        ...report.conformance.exercised,
        provider: "unobserved-module:provider",
      },
    },
  };
}

function makeMalformedExercisedTargetReport() {
  const report = makeCompleteReport("provider");
  return {
    ...report,
    conformance: {
      ...report.conformance,
      exercised: {
        ...report.conformance.exercised,
        provider: "sample-module",
      },
    },
  };
}

function makeBogusTrustReport() {
  const report = makeCompleteReport("provider");
  return {
    ...report,
    sync: {
      ...report.sync,
      trustDecisions: [
        {
          moduleId: "unobserved-module",
          pluginName: "@remote/unobserved",
          endpointId: "sample-endpoint",
          trusted: true,
          reason: "allowed",
        },
      ],
    },
  };
}

function makeBogusRegistrationReport() {
  const report = makeCompleteReport("provider");
  return {
    ...report,
    sync: {
      ...report.sync,
      registered: ["@remote/other"],
      registeredModules: [
        {
          pluginName: "@remote/other",
          moduleId: "sample-module",
          endpointId: "sample-endpoint",
          ...makeRegisteredModuleCounts(),
        },
      ],
    },
  };
}

function makeDuplicateModuleReport() {
  const report = makeCompleteReport("provider");
  return {
    ...report,
    conformance: {
      ...report.conformance,
      moduleCount: 2,
      moduleIds: ["sample-module", "sample-module"],
    },
  };
}

function makeDuplicateRegisteredModuleReport() {
  const report = makeCompleteReport("provider");
  return {
    ...report,
    sync: {
      ...report.sync,
      registered: ["@remote/sample", "@remote/alias"],
      registeredModules: [
        {
          pluginName: "@remote/sample",
          moduleId: "sample-module",
          endpointId: "sample-endpoint",
          ...makeRegisteredModuleCounts(),
        },
        {
          pluginName: "@remote/sample",
          moduleId: "sample-module",
          endpointId: "sample-endpoint",
          ...makeRegisteredModuleCounts(),
        },
      ],
    },
    runtime: {
      ...report.runtime,
      remotePlugins: [
        ...report.runtime.remotePlugins,
        {
          pluginName: "@remote/manifest-only",
          moduleId: "manifest-only-module",
          endpointId: "sample-endpoint",
        },
      ],
      pluginCount: 2,
      actionCount: 2,
      providerCount: 2,
      evaluatorCount: 2,
      responseHandlerEvaluatorCount: 2,
      responseHandlerFieldEvaluatorCount: 2,
      routeCount: 2,
      modelCount: 2,
      eventCount: 2,
      serviceCount: 2,
      appCount: 2,
      appBridgeCount: 2,
      lifecycleCount: 2,
      widgetCount: 2,
      componentTypeCount: 2,
      viewCount: 2,
    },
  };
}

function makeDuplicateRegisteredPluginReport() {
  const report = makeCompleteReport("provider");
  return {
    ...report,
    sync: {
      ...report.sync,
      registered: ["@remote/sample", "@remote/sample"],
    },
    runtime: {
      ...report.runtime,
      remotePlugins: [
        ...report.runtime.remotePlugins,
        {
          pluginName: "@remote/unexercised",
          moduleId: "unexercised-module",
          endpointId: "sample-endpoint",
        },
      ],
      pluginCount: 2,
    },
  };
}

function makeDuplicateTrustDecisionReport() {
  const report = makeCompleteReport("provider");
  const trustDecision = {
    moduleId: "sample-module",
    pluginName: "@remote/sample",
    endpointId: "sample-endpoint",
    trusted: true,
    reason: "allowed",
  };
  return {
    ...report,
    sync: {
      ...report.sync,
      trustDecisions: [trustDecision, trustDecision],
    },
  };
}

function makeRegisteredSkippedReport() {
  const report = makeCompleteReport("provider");
  return {
    ...report,
    sync: {
      ...report.sync,
      skipped: ["@remote/sample"],
    },
  };
}

function makeRegisteredUnloadedReport() {
  const report = makeCompleteReport("provider");
  return {
    ...report,
    sync: {
      ...report.sync,
      unloaded: ["@remote/sample"],
    },
  };
}

function makeSkippedUnloadedOverlapReport() {
  const report = makeCompleteReport("provider");
  return {
    ...report,
    sync: {
      ...report.sync,
      skipped: ["@remote/old"],
      unloaded: ["@remote/old"],
    },
  };
}

function makeSkippedMissingTrustReport() {
  const report = makeCompleteReport("provider");
  return {
    ...report,
    sync: {
      ...report.sync,
      skipped: ["@remote/foreign"],
    },
  };
}

function makeDuplicateSkippedReport() {
  const report = makeCompleteReport("provider");
  return {
    ...report,
    sync: {
      ...report.sync,
      skipped: ["@remote/old", "@remote/old"],
    },
  };
}

function makeDuplicateUnloadedReport() {
  const report = makeCompleteReport("provider");
  return {
    ...report,
    sync: {
      ...report.sync,
      unloaded: ["@remote/old", "@remote/old"],
    },
  };
}

function makeExercisedUnregisteredReport() {
  const report = makeCompleteReport("provider");
  return {
    ...report,
    conformance: {
      ...report.conformance,
      moduleCount: 2,
      moduleIds: ["sample-module", "manifest-only-module"],
      exercised: {
        ...report.conformance.exercised,
        service: "manifest-only-module:service",
      },
      moduleExercises: report.conformance.moduleExercises.map((exercise) =>
        exercise.surface === "service"
          ? {
              surface: "service",
              moduleId: "manifest-only-module",
              target: "manifest-only-module:service",
            }
          : exercise,
      ),
      rpcCalls: report.conformance.rpcCalls.map((call) =>
        call.surface === "service"
          ? {
              method: "plugin.service.call",
              surface: "service",
              moduleId: "manifest-only-module",
              target: "manifest-only-module:service",
            }
          : call,
      ),
    },
    sync: {
      ...report.sync,
      registered: ["@remote/sample", "@remote/manifest-only"],
      registeredModules: [
        {
          pluginName: "@remote/sample",
          moduleId: "sample-module",
          endpointId: "sample-endpoint",
          ...makeRegisteredModuleCounts(),
        },
        {
          pluginName: "@remote/manifest-only",
          moduleId: "manifest-only-module",
          endpointId: "sample-endpoint",
          ...makeRegisteredModuleCounts(),
        },
      ],
      trustDecisions: [
        {
          moduleId: "sample-module",
          pluginName: "@remote/sample",
          endpointId: "sample-endpoint",
          trusted: true,
          reason: "allowed",
        },
      ],
    },
    runtime: {
      ...report.runtime,
      pluginCount: 2,
      actionCount: 2,
      providerCount: 2,
      evaluatorCount: 2,
      responseHandlerEvaluatorCount: 2,
      responseHandlerFieldEvaluatorCount: 2,
      routeCount: 2,
      modelCount: 2,
      eventCount: 2,
      serviceCount: 2,
      appCount: 2,
      appBridgeCount: 2,
      lifecycleCount: 2,
      widgetCount: 2,
      componentTypeCount: 2,
      viewCount: 2,
    },
  };
}

function makeRegisteredUnexercisedReport() {
  const report = makeCompleteReport("provider");
  return {
    ...report,
    conformance: {
      ...report.conformance,
      moduleCount: 2,
      moduleIds: ["sample-module", "unexercised-module"],
    },
    sync: {
      ...report.sync,
      registered: ["@remote/sample", "@remote/unexercised"],
      registeredModules: [
        {
          pluginName: "@remote/sample",
          moduleId: "sample-module",
          endpointId: "sample-endpoint",
          ...makeRegisteredModuleCounts(),
        },
        {
          pluginName: "@remote/unexercised",
          moduleId: "unexercised-module",
          endpointId: "sample-endpoint",
          ...makeRegisteredModuleCounts(),
        },
      ],
      trustDecisions: [
        {
          moduleId: "sample-module",
          pluginName: "@remote/sample",
          endpointId: "sample-endpoint",
          trusted: true,
          reason: "allowed",
        },
        {
          moduleId: "unexercised-module",
          pluginName: "@remote/unexercised",
          endpointId: "sample-endpoint",
          trusted: true,
          reason: "allowed",
        },
      ],
    },
    runtime: {
      ...report.runtime,
      pluginCount: 2,
      actionCount: 2,
      providerCount: 2,
      evaluatorCount: 2,
      responseHandlerEvaluatorCount: 2,
      responseHandlerFieldEvaluatorCount: 2,
      routeCount: 2,
      modelCount: 2,
      eventCount: 2,
      serviceCount: 2,
      appCount: 2,
      appBridgeCount: 2,
      lifecycleCount: 2,
      widgetCount: 2,
      componentTypeCount: 2,
      viewCount: 2,
    },
  };
}

function makeMissingSummaryModuleExerciseReport() {
  const report = makeCompleteReport("provider");
  return {
    ...report,
    conformance: {
      ...report.conformance,
      moduleExercises: [
        {
          surface: "action",
          moduleId: "sample-module",
          target: "sample-module:different-action",
        },
      ],
    },
  };
}

function makeDuplicateModuleExerciseReport() {
  const report = makeCompleteReport("provider");
  return {
    ...report,
    conformance: {
      ...report.conformance,
      moduleExercises: [
        ...report.conformance.moduleExercises,
        report.conformance.moduleExercises[0],
      ],
    },
  };
}

function makeMissingModuleExercisesReport() {
  const report = makeCompleteReport("provider");
  const { moduleExercises: _moduleExercises, ...conformance } =
    report.conformance;
  return {
    ...report,
    conformance,
  };
}

function makeMissingRuntimeRemotePluginReport() {
  const report = makeCompleteReport("provider");
  return {
    ...report,
    runtime: {
      ...report.runtime,
      remotePlugins: [],
    },
  };
}

function makeStaleRuntimeRemotePluginReport() {
  const report = makeCompleteReport("provider");
  return {
    ...report,
    runtime: {
      ...report.runtime,
      remotePlugins: [
        ...report.runtime.remotePlugins,
        {
          pluginName: "@remote/stale",
          moduleId: "stale-module",
          endpointId: "sample-endpoint",
        },
      ],
    },
  };
}

function makeMissingRpcCallsReport() {
  const report = makeCompleteReport("provider");
  const { rpcCalls: _rpcCalls, ...conformance } = report.conformance;
  return {
    ...report,
    conformance,
  };
}

function makeInvalidRpcMethodReport() {
  const report = makeCompleteReport("provider");
  return {
    ...report,
    conformance: {
      ...report.conformance,
      rpcCalls: report.conformance.rpcCalls.map((call, index) =>
        index === 0
          ? {
              ...call,
              method: "plugin.action.run",
            }
          : call,
      ),
    },
  };
}

function makeMissingRequiredRpcMethodReport() {
  const report = makeCompleteReport("provider");
  return {
    ...report,
    conformance: {
      ...report.conformance,
      rpcCalls: report.conformance.rpcCalls.filter(
        (call) => call.method !== "plugin.evaluator.process",
      ),
    },
  };
}

function makeManifestOnlyUnregisteredReport() {
  const report = makeCompleteReport("provider");
  return {
    ...report,
    conformance: {
      ...report.conformance,
      moduleCount: 2,
      moduleIds: ["sample-module", "manifest-only-module"],
    },
  };
}

function makeRuntimeUndercountReport() {
  const report = makeCompleteReport("provider");
  return {
    ...report,
    sync: {
      ...report.sync,
      registeredModules: [
        {
          pluginName: "@remote/sample",
          moduleId: "sample-module",
          endpointId: "sample-endpoint",
          ...makeRegisteredModuleCounts({ actionCount: 2 }),
        },
      ],
    },
    runtime: {
      ...report.runtime,
      remotePlugins: report.runtime.remotePlugins.map((plugin, index) =>
        index === 0 ? { ...plugin, actionCount: 2 } : plugin,
      ),
      actionCount: 1,
    },
  };
}

function makeRuntimePluginUndercountReport() {
  const report = makeCompleteReport("provider");
  return {
    ...report,
    conformance: {
      ...report.conformance,
      moduleCount: 2,
      moduleIds: ["sample-module", "second-module"],
      exercised: {
        ...report.conformance.exercised,
        service: "second-module:service",
      },
      moduleExercises: report.conformance.moduleExercises.map((exercise) =>
        exercise.surface === "service"
          ? {
              surface: "service",
              moduleId: "second-module",
              target: "second-module:service",
            }
          : exercise,
      ),
      rpcCalls: report.conformance.rpcCalls.map((call) =>
        call.surface === "service"
          ? {
              method: "plugin.service.call",
              surface: "service",
              moduleId: "second-module",
              target: "second-module:service",
            }
          : call,
      ),
    },
    sync: {
      ...report.sync,
      registered: ["@remote/sample", "@remote/second"],
      registeredModules: [
        {
          pluginName: "@remote/sample",
          moduleId: "sample-module",
          endpointId: "sample-endpoint",
          ...makeRegisteredModuleCounts(),
        },
        {
          pluginName: "@remote/second",
          moduleId: "second-module",
          endpointId: "sample-endpoint",
          ...makeRegisteredModuleCounts(),
        },
      ],
      trustDecisions: [
        {
          moduleId: "sample-module",
          pluginName: "@remote/sample",
          endpointId: "sample-endpoint",
          trusted: true,
          reason: "allowed",
        },
        {
          moduleId: "second-module",
          pluginName: "@remote/second",
          endpointId: "sample-endpoint",
          trusted: true,
          reason: "allowed",
        },
      ],
    },
    runtime: {
      ...report.runtime,
      remotePlugins: [
        ...report.runtime.remotePlugins,
        {
          pluginName: "@remote/second",
          moduleId: "second-module",
          endpointId: "sample-endpoint",
          ...makeRegisteredModuleCounts(),
        },
      ],
      actionCount: 2,
      providerCount: 2,
      evaluatorCount: 2,
      responseHandlerEvaluatorCount: 2,
      responseHandlerFieldEvaluatorCount: 2,
      routeCount: 2,
      modelCount: 2,
      eventCount: 2,
      serviceCount: 2,
      appCount: 2,
      appBridgeCount: 2,
      lifecycleCount: 2,
      widgetCount: 2,
      componentTypeCount: 2,
      viewCount: 2,
    },
  };
}

function makeMismatchedRuntimeRemotePluginCountReport() {
  const report = makeCompleteReport("provider");
  return {
    ...report,
    runtime: {
      ...report.runtime,
      remotePlugins: report.runtime.remotePlugins.map((plugin, index) =>
        index === 0 ? { ...plugin, routeCount: 0 } : plugin,
      ),
    },
  };
}

function makeMissingRegisteredServiceReport() {
  const report = makeCompleteReport("provider");
  return {
    ...report,
    sync: {
      ...report.sync,
      registeredModules: [
        {
          pluginName: "@remote/sample",
          moduleId: "sample-module",
          endpointId: "sample-endpoint",
          ...makeRegisteredModuleCounts({ serviceCount: 0 }),
        },
      ],
    },
  };
}

function makeRegisteredModuleCounts(
  overrides: Partial<Record<string, number>> = {},
) {
  return {
    actionCount: 1,
    providerCount: 1,
    evaluatorCount: 1,
    responseHandlerEvaluatorCount: 1,
    responseHandlerFieldEvaluatorCount: 1,
    routeCount: 1,
    modelCount: 1,
    eventCount: 1,
    serviceCount: 1,
    appCount: 1,
    appBridgeCount: 1,
    lifecycleCount: 1,
    widgetCount: 1,
    componentTypeCount: 1,
    viewCount: 1,
    ...overrides,
  };
}

function makeMissingEvaluatorMaterializationReport() {
  const report = makeCompleteReport("provider");
  return {
    ...report,
    runtime: {
      ...report.runtime,
      evaluatorCount: 0,
    },
  };
}

function makeMissingEventMaterializationReport() {
  const report = makeCompleteReport("provider");
  return {
    ...report,
    runtime: {
      ...report.runtime,
      eventCount: 0,
    },
  };
}

function makeMissingServiceMaterializationReport() {
  const report = makeCompleteReport("provider");
  return {
    ...report,
    runtime: {
      ...report.runtime,
      serviceCount: 0,
    },
  };
}

function makeMissingAppMaterializationReport() {
  const report = makeCompleteReport("provider");
  return {
    ...report,
    runtime: {
      ...report.runtime,
      appCount: 0,
    },
  };
}

function makeMissingFieldEvaluatorMaterializationReport() {
  const report = makeCompleteReport("provider");
  return {
    ...report,
    runtime: {
      ...report.runtime,
      responseHandlerFieldEvaluatorCount: 0,
    },
  };
}

function assertRejected(
  result: { exitCode: number; output: string },
  expectedDiagnostic: string,
  fixture: string,
): void {
  if (result.exitCode === 0) {
    throw new Error(`${fixture} unexpectedly passed validation.`);
  }
  if (!result.output.includes(expectedDiagnostic)) {
    throw new Error(`${fixture} failed for the wrong reason: ${result.output}`);
  }
}

async function runValidator(
  path: string,
  ...argsAndMaybeEnv: Array<string | Record<string, string>>
): Promise<{
  exitCode: number;
  output: string;
}> {
  const env =
    typeof argsAndMaybeEnv.at(-1) === "object"
      ? (argsAndMaybeEnv.pop() as Record<string, string>)
      : undefined;
  const args = argsAndMaybeEnv as string[];
  const proc = Bun.spawn(["bun", scriptPath, ...args, path], {
    env: {
      ...process.env,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, output: `${stdout}${stderr}` };
}

await main();
