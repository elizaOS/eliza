import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
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
    const completePartialModuleDir = join(
      workspace,
      "complete-partial-module",
    );
    const cloudOnlyDir = join(workspace, "cloud-only");
    const ciDir = join(workspace, "ci");
    const providerCiDir = join(workspace, "provider-ci");
    const malformedCiDir = join(workspace, "malformed-ci");
    const pushCiDir = join(workspace, "push-ci");
    const providerOnlyDir = join(workspace, "provider-only");
    const requiredProvidersDir = join(workspace, "required-providers");
    const fourProvidersDir = join(workspace, "four-providers");
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
    const nonJavascriptAssetDir = join(workspace, "non-javascript-asset");
    const mismatchedAssetManifestDir = join(
      workspace,
      "mismatched-asset-manifest",
    );
    const missingAssetDigestDir = join(workspace, "missing-asset-digest");
    const malformedAssetDigestDir = join(workspace, "malformed-asset-digest");
    const mismatchDir = join(workspace, "mismatch");
    const malformedEndpointIdDir = join(workspace, "malformed-endpoint-id");
    const malformedProviderDir = join(workspace, "malformed-provider");
    const malformedCloudApiBaseDir = join(
      workspace,
      "malformed-cloud-api-base",
    );
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
    const registeredUnexercisedDir = join(
      workspace,
      "registered-unexercised",
    );
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
    await mkdir(fourProvidersDir, { recursive: true });
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
    await mkdir(nonJavascriptAssetDir, { recursive: true });
    await mkdir(mismatchedAssetManifestDir, { recursive: true });
    await mkdir(missingAssetDigestDir, { recursive: true });
    await mkdir(malformedAssetDigestDir, { recursive: true });
    await mkdir(mismatchDir, { recursive: true });
    await mkdir(malformedEndpointIdDir, { recursive: true });
    await mkdir(malformedProviderDir, { recursive: true });
    await mkdir(malformedCloudApiBaseDir, { recursive: true });
    await mkdir(cloudApiBaseQueryDir, { recursive: true });
    await mkdir(cloudApiBaseFragmentDir, { recursive: true });
    await mkdir(matchingFileIdentityDir, { recursive: true });
    await mkdir(mismatchedFileIdentityDir, { recursive: true });
    await mkdir(mismatchedCloudFileIdentityDir, { recursive: true });
    await mkdir(duplicateEndpointDir, { recursive: true });
    await mkdir(duplicateProviderDir, { recursive: true });
    await mkdir(duplicateEndpointUrlFingerprintDir, { recursive: true });
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
      join(requiredProvidersDir, "e2b.json"),
      `${JSON.stringify(makeCompleteReport("provider", "required-e2b-endpoint", "e2b"), null, 2)}\n`,
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
      join(fourProvidersDir, "e2b.json"),
      `${JSON.stringify(makeCompleteReport("provider", "four-e2b-endpoint", "e2b"), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(fourProvidersDir, "home-machine.json"),
      `${JSON.stringify(makeCompleteReport("provider", "four-home-endpoint", "home-machine"), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(fourProvidersDir, "mobile-companion.json"),
      `${JSON.stringify(makeCompleteReport("provider", "four-mobile-endpoint", "mobile-companion"), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(fourProvidersDir, "desktop-companion.json"),
      `${JSON.stringify(makeCompleteReport("provider", "four-desktop-endpoint", "desktop-companion"), null, 2)}\n`,
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
      `${JSON.stringify(makeCompleteReport("provider", "fresh-endpoint", "e2b", new Date().toISOString()), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(staleDir, "provider.json"),
      `${JSON.stringify(makeCompleteReport("provider", "stale-endpoint"), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(nearFutureDir, "provider.json"),
      `${JSON.stringify(makeCompleteReport("provider", "near-future-endpoint", "e2b", new Date(Date.now() + 60_000).toISOString()), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(farFutureDir, "provider.json"),
      `${JSON.stringify(makeCompleteReport("provider", "far-future-endpoint", "e2b", new Date(Date.now() + 10 * 60_000).toISOString()), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(malformedObservedAtDir, "provider.json"),
      `${JSON.stringify(makeCompleteReport("provider", "malformed-observed-at-endpoint", "e2b", "not-a-timestamp"), null, 2)}\n`,
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
      join(matchingFileIdentityDir, "e2b.json"),
      `${JSON.stringify(makeCompleteReport("provider", "matching-file-endpoint", "e2b"), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(mismatchedFileIdentityDir, "home-machine.json"),
      `${JSON.stringify(makeCompleteReport("provider", "mismatched-file-endpoint", "e2b"), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(mismatchedCloudFileIdentityDir, "cloud-live.json"),
      `${JSON.stringify(makeCompleteReport("cloud", "mismatched-cloud-file-endpoint"), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(duplicateEndpointDir, "provider-a.json"),
      `${JSON.stringify(makeCompleteReport("provider", "shared-endpoint", "e2b"), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(duplicateEndpointDir, "provider-b.json"),
      `${JSON.stringify(makeCompleteReport("provider", "shared-endpoint", "home-machine"), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(duplicateProviderDir, "provider-a.json"),
      `${JSON.stringify(makeCompleteReport("provider", "provider-endpoint-a", "e2b"), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(duplicateProviderDir, "provider-b.json"),
      `${JSON.stringify(makeCompleteReport("provider", "provider-endpoint-b", "e2b"), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(duplicateEndpointUrlFingerprintDir, "provider-a.json"),
      `${JSON.stringify(makeCompleteReport("provider", "fingerprint-endpoint-a", "e2b"), null, 2)}\n`,
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
            "e2b",
          ),
        },
        null,
        2,
      )}\n`,
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
    if (wrongCloudCount.exitCode === 0) {
      throw new Error("wrong cloud count unexpectedly passed validation.");
    }
    if (!wrongCloudCount.output.includes("expected 1 report(s), got 2")) {
      throw new Error(
        `wrong cloud count failed for the wrong reason: ${wrongCloudCount.output}`,
      );
    }
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
    if (mismatchedProviderCi.exitCode === 0) {
      throw new Error(
        "mismatched provider ci report unexpectedly passed validation.",
      );
    }
    if (
      !mismatchedProviderCi.output.includes(
        "ci.runAttempt must match GITHUB_RUN_ATTEMPT",
      )
    ) {
      throw new Error(
        `mismatched provider ci failed for the wrong reason: ${mismatchedProviderCi.output}`,
      );
    }
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
    if (mismatchedCi.exitCode === 0) {
      throw new Error("mismatched ci report unexpectedly passed validation.");
    }
    if (!mismatchedCi.output.includes("ci.runId must match GITHUB_RUN_ID")) {
      throw new Error(
        `mismatched ci failed for the wrong reason: ${mismatchedCi.output}`,
      );
    }
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
    if (missingGithubEnv.exitCode === 0) {
      throw new Error(
        "missing GitHub env report unexpectedly passed validation.",
      );
    }
    if (!missingGithubEnv.output.includes("GITHUB_REF must be set")) {
      throw new Error(
        `missing GitHub env failed for the wrong reason: ${missingGithubEnv.output}`,
      );
    }
    const malformedCi = await runValidator(
      malformedCiDir,
      "--kind=cloud",
      "--require-ci",
    );
    if (malformedCi.exitCode === 0) {
      throw new Error("malformed ci report unexpectedly passed validation.");
    }
    if (!malformedCi.output.includes("ci.sha has invalid format")) {
      throw new Error(
        `malformed ci failed for the wrong reason: ${malformedCi.output}`,
      );
    }
    const pushCi = await runValidator(
      pushCiDir,
      "--kind=cloud",
      "--require-ci",
    );
    if (pushCi.exitCode === 0) {
      throw new Error("push ci report unexpectedly passed validation.");
    }
    if (
      !pushCi.output.includes(
        "ci.eventName must be workflow_dispatch or schedule",
      )
    ) {
      throw new Error(`push ci failed for the wrong reason: ${pushCi.output}`);
    }
    const missingCi = await runValidator(
      cloudOnlyDir,
      "--kind=cloud",
      "--require-ci",
    );
    if (missingCi.exitCode === 0) {
      throw new Error("missing ci report unexpectedly passed validation.");
    }
    if (!missingCi.output.includes("ci must be an object")) {
      throw new Error(
        `missing ci failed for the wrong reason: ${missingCi.output}`,
      );
    }
    const providerKind = await runValidator(providerOnlyDir, "--kind=provider");
    if (providerKind.exitCode !== 0) {
      throw new Error(
        `provider kind reports should validate, got ${providerKind.exitCode}: ${providerKind.output}`,
      );
    }
    const requiredProviders = await runValidator(
      requiredProvidersDir,
      "--kind=provider",
      "--expect-count=3..4",
      "--require-providers",
      "e2b,home-machine,mobile-companion",
    );
    if (requiredProviders.exitCode !== 0) {
      throw new Error(
        `required provider reports should validate, got ${requiredProviders.exitCode}: ${requiredProviders.output}`,
      );
    }
    const fourProviders = await runValidator(
      fourProvidersDir,
      "--kind=provider",
      "--expect-count=3..4",
      "--allowed-providers=e2b,home-machine,mobile-companion,desktop-companion",
      "--require-providers=e2b,home-machine,mobile-companion",
    );
    if (fourProviders.exitCode !== 0) {
      throw new Error(
        `four provider reports should validate, got ${fourProviders.exitCode}: ${fourProviders.output}`,
      );
    }
    const missingRequiredProvider = await runValidator(
      providerOnlyDir,
      "--kind=provider",
      "--require-providers=e2b,home-machine",
    );
    if (missingRequiredProvider.exitCode === 0) {
      throw new Error(
        "missing required provider report unexpectedly passed validation.",
      );
    }
    if (
      !missingRequiredProvider.output.includes(
        'required provider "home-machine" was not observed',
      )
    ) {
      throw new Error(
        `missing required provider failed for the wrong reason: ${missingRequiredProvider.output}`,
      );
    }
    const unknownProvider = await runValidator(
      unknownProviderDir,
      "--kind=provider",
      "--allowed-providers=e2b,home-machine,mobile-companion,desktop-companion",
    );
    if (unknownProvider.exitCode === 0) {
      throw new Error(
        "unknown provider report unexpectedly passed validation.",
      );
    }
    if (!unknownProvider.output.includes("is not in --allowed-providers")) {
      throw new Error(
        `unknown provider failed for the wrong reason: ${unknownProvider.output}`,
      );
    }
    const duplicateEndpointUrlFingerprint = await runValidator(
      duplicateEndpointUrlFingerprintDir,
      "--kind=provider",
    );
    if (duplicateEndpointUrlFingerprint.exitCode === 0) {
      throw new Error(
        "duplicate endpoint URL fingerprint unexpectedly passed validation.",
      );
    }
    if (
      !duplicateEndpointUrlFingerprint.output.includes(
        "endpointUrlSha256 duplicates",
      )
    ) {
      throw new Error(
        `duplicate endpoint URL fingerprint failed for the wrong reason: ${duplicateEndpointUrlFingerprint.output}`,
      );
    }
    const missingEndpointUrlFingerprint = await runValidator(
      missingEndpointUrlFingerprintDir,
      "--kind=provider",
    );
    if (missingEndpointUrlFingerprint.exitCode === 0) {
      throw new Error(
        "missing endpoint URL fingerprint unexpectedly passed validation.",
      );
    }
    if (
      !missingEndpointUrlFingerprint.output.includes(
        "endpointUrlSha256 must be a non-empty string",
      )
    ) {
      throw new Error(
        `missing endpoint URL fingerprint failed for the wrong reason: ${missingEndpointUrlFingerprint.output}`,
      );
    }
    const malformedEndpointUrlFingerprint = await runValidator(
      malformedEndpointUrlFingerprintDir,
      "--kind=provider",
    );
    if (malformedEndpointUrlFingerprint.exitCode === 0) {
      throw new Error(
        "malformed endpoint URL fingerprint unexpectedly passed validation.",
      );
    }
    if (
      !malformedEndpointUrlFingerprint.output.includes(
        "endpointUrlSha256 has invalid format",
      )
    ) {
      throw new Error(
        `malformed endpoint URL fingerprint failed for the wrong reason: ${malformedEndpointUrlFingerprint.output}`,
      );
    }
    const kindMismatch = await runValidator(providerOnlyDir, "--kind", "cloud");
    if (kindMismatch.exitCode === 0) {
      throw new Error("kind mismatch report unexpectedly passed validation.");
    }
    if (!kindMismatch.output.includes('kind must be "cloud"')) {
      throw new Error(
        `kind mismatch failed for the wrong reason: ${kindMismatch.output}`,
      );
    }
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
    if (stale.exitCode === 0) {
      throw new Error("stale report unexpectedly passed validation.");
    }
    if (!stale.output.includes("observedAt is older")) {
      throw new Error(
        `stale report failed for the wrong reason: ${stale.output}`,
      );
    }
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
    if (farFuture.exitCode === 0) {
      throw new Error("far-future report unexpectedly passed validation.");
    }
    if (!farFuture.output.includes("observedAt is newer")) {
      throw new Error(
        `far-future report failed for the wrong reason: ${farFuture.output}`,
      );
    }
    const malformedObservedAt = await runValidator(malformedObservedAtDir);
    if (malformedObservedAt.exitCode === 0) {
      throw new Error("malformed observedAt report unexpectedly passed.");
    }
    if (!malformedObservedAt.output.includes("observedAt must be an ISO timestamp")) {
      throw new Error(
        `malformed observedAt failed for the wrong reason: ${malformedObservedAt.output}`,
      );
    }
    const wrongSchema = await runValidator(wrongSchemaDir);
    if (wrongSchema.exitCode === 0) {
      throw new Error("wrong schema report unexpectedly passed validation.");
    }
    if (!wrongSchema.output.includes("schemaVersion must be 1")) {
      throw new Error(
        `wrong schema report failed for the wrong reason: ${wrongSchema.output}`,
      );
    }
    const partial = await runValidator(partialDir);
    if (partial.exitCode === 0) {
      throw new Error("partial report unexpectedly passed validation.");
    }
    if (!partial.output.includes("conformance.exercised.provider")) {
      throw new Error(
        `partial report failed for the wrong reason: ${partial.output}`,
      );
    }
    const failedRoute = await runValidator(failedRouteDir);
    if (failedRoute.exitCode === 0) {
      throw new Error("failed route report unexpectedly passed validation.");
    }
    if (
      !failedRoute.output.includes(
        "conformance.routeResult.status must be a 2xx HTTP status",
      )
    ) {
      throw new Error(
        `failed route report failed for the wrong reason: ${failedRoute.output}`,
      );
    }
    const nonJavascriptAsset = await runValidator(nonJavascriptAssetDir);
    if (nonJavascriptAsset.exitCode === 0) {
      throw new Error(
        "non-JavaScript asset report unexpectedly passed validation.",
      );
    }
    if (
      !nonJavascriptAsset.output.includes(
        "conformance.assetResult.path must be a JavaScript asset",
      )
    ) {
      throw new Error(
        `non-JavaScript asset report failed for the wrong reason: ${nonJavascriptAsset.output}`,
      );
    }
    const mismatchedAssetManifest = await runValidator(
      mismatchedAssetManifestDir,
    );
    if (mismatchedAssetManifest.exitCode === 0) {
      throw new Error(
        "mismatched asset manifest report unexpectedly passed validation.",
      );
    }
    if (
      !mismatchedAssetManifest.output.includes(
        "conformance.assetResult.manifestContentType must match",
      )
    ) {
      throw new Error(
        `mismatched asset manifest failed for the wrong reason: ${mismatchedAssetManifest.output}`,
      );
    }
    const missingAssetDigest = await runValidator(missingAssetDigestDir);
    if (missingAssetDigest.exitCode === 0) {
      throw new Error("missing asset digest report unexpectedly passed.");
    }
    if (
      !missingAssetDigest.output.includes(
        "conformance.assetResult.sha256 must be a non-empty string",
      )
    ) {
      throw new Error(
        `missing asset digest failed for the wrong reason: ${missingAssetDigest.output}`,
      );
    }
    const malformedAssetDigest = await runValidator(malformedAssetDigestDir);
    if (malformedAssetDigest.exitCode === 0) {
      throw new Error("malformed asset digest report unexpectedly passed.");
    }
    if (
      !malformedAssetDigest.output.includes(
        "conformance.assetResult.sha256 has invalid format",
      )
    ) {
      throw new Error(
        `malformed asset digest failed for the wrong reason: ${malformedAssetDigest.output}`,
      );
    }
    const mismatch = await runValidator(mismatchDir);
    if (mismatch.exitCode === 0) {
      throw new Error(
        "endpoint mismatch report unexpectedly passed validation.",
      );
    }
    if (
      !mismatch.output.includes("conformance.endpointId must match endpointId")
    ) {
      throw new Error(
        `endpoint mismatch failed for the wrong reason: ${mismatch.output}`,
      );
    }
    const malformedEndpointId = await runValidator(malformedEndpointIdDir);
    if (malformedEndpointId.exitCode === 0) {
      throw new Error("malformed endpoint id unexpectedly passed validation.");
    }
    if (!malformedEndpointId.output.includes("endpointId must contain only")) {
      throw new Error(
        `malformed endpoint id failed for the wrong reason: ${malformedEndpointId.output}`,
      );
    }
    const malformedProvider = await runValidator(malformedProviderDir);
    if (malformedProvider.exitCode === 0) {
      throw new Error("malformed provider unexpectedly passed validation.");
    }
    if (!malformedProvider.output.includes("provider must use lowercase")) {
      throw new Error(
        `malformed provider failed for the wrong reason: ${malformedProvider.output}`,
      );
    }
    const malformedCloudApiBase = await runValidator(malformedCloudApiBaseDir);
    if (malformedCloudApiBase.exitCode === 0) {
      throw new Error("malformed cloudApiBase unexpectedly passed validation.");
    }
    if (
      !malformedCloudApiBase.output.includes(
        "cloudApiBase must be an absolute http(s) URL",
      )
    ) {
      throw new Error(
        `malformed cloudApiBase failed for the wrong reason: ${malformedCloudApiBase.output}`,
      );
    }
    const cloudApiBaseQuery = await runValidator(cloudApiBaseQueryDir);
    if (cloudApiBaseQuery.exitCode === 0) {
      throw new Error("cloudApiBase query report unexpectedly passed.");
    }
    if (
      !cloudApiBaseQuery.output.includes(
        "cloudApiBase must not include query or fragment components",
      )
    ) {
      throw new Error(
        `cloudApiBase query failed for the wrong reason: ${cloudApiBaseQuery.output}`,
      );
    }
    const cloudApiBaseFragment = await runValidator(cloudApiBaseFragmentDir);
    if (cloudApiBaseFragment.exitCode === 0) {
      throw new Error("cloudApiBase fragment report unexpectedly passed.");
    }
    if (
      !cloudApiBaseFragment.output.includes(
        "cloudApiBase must not include query or fragment components",
      )
    ) {
      throw new Error(
        `cloudApiBase fragment failed for the wrong reason: ${cloudApiBaseFragment.output}`,
      );
    }
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
    if (mismatchedFileIdentity.exitCode === 0) {
      throw new Error("mismatched file identity unexpectedly passed.");
    }
    if (
      !mismatchedFileIdentity.output.includes(
        "provider report filename must match provider",
      )
    ) {
      throw new Error(
        `mismatched file identity failed for the wrong reason: ${mismatchedFileIdentity.output}`,
      );
    }
    const mismatchedCloudFileIdentity = await runValidator(
      mismatchedCloudFileIdentityDir,
      "--kind=cloud",
      "--require-file-identity",
    );
    if (mismatchedCloudFileIdentity.exitCode === 0) {
      throw new Error("mismatched cloud file identity unexpectedly passed.");
    }
    if (
      !mismatchedCloudFileIdentity.output.includes(
        'cloud report filename must be "cloud.json"',
      )
    ) {
      throw new Error(
        `mismatched cloud file identity failed for the wrong reason: ${mismatchedCloudFileIdentity.output}`,
      );
    }
    const duplicateEndpoint = await runValidator(duplicateEndpointDir);
    if (duplicateEndpoint.exitCode === 0) {
      throw new Error("duplicate endpoint reports unexpectedly passed.");
    }
    if (!duplicateEndpoint.output.includes("endpointId duplicates")) {
      throw new Error(
        `duplicate endpoint failed for the wrong reason: ${duplicateEndpoint.output}`,
      );
    }
    const duplicateProvider = await runValidator(duplicateProviderDir);
    if (duplicateProvider.exitCode === 0) {
      throw new Error("duplicate provider reports unexpectedly passed.");
    }
    if (!duplicateProvider.output.includes("provider duplicates")) {
      throw new Error(
        `duplicate provider failed for the wrong reason: ${duplicateProvider.output}`,
      );
    }
    const leakedSecret = await runValidator(leakedSecretDir);
    if (leakedSecret.exitCode === 0) {
      throw new Error("leaked secret report unexpectedly passed validation.");
    }
    if (!leakedSecret.output.includes("must not be present")) {
      throw new Error(
        `leaked secret failed for the wrong reason: ${leakedSecret.output}`,
      );
    }
    const leakedSecretValue = await runValidator(leakedSecretValueDir);
    if (leakedSecretValue.exitCode === 0) {
      throw new Error(
        "leaked secret value report unexpectedly passed validation.",
      );
    }
    if (!leakedSecretValue.output.includes("credential-shaped string values")) {
      throw new Error(
        `leaked secret value failed for the wrong reason: ${leakedSecretValue.output}`,
      );
    }
    const bogusTarget = await runValidator(bogusTargetDir);
    if (bogusTarget.exitCode === 0) {
      throw new Error(
        "bogus exercised target report unexpectedly passed validation.",
      );
    }
    if (!bogusTarget.output.includes("must start with an observed module id")) {
      throw new Error(
        `bogus exercised target failed for the wrong reason: ${bogusTarget.output}`,
      );
    }
    const malformedTarget = await runValidator(malformedTargetDir);
    if (malformedTarget.exitCode === 0) {
      throw new Error(
        "malformed exercised target report unexpectedly passed validation.",
      );
    }
    if (
      !malformedTarget.output.includes(
        "must start with an observed module id followed by",
      )
    ) {
      throw new Error(
        `malformed exercised target failed for the wrong reason: ${malformedTarget.output}`,
      );
    }
    const bogusTrust = await runValidator(bogusTrustDir);
    if (bogusTrust.exitCode === 0) {
      throw new Error("bogus trust report unexpectedly passed validation.");
    }
    if (!bogusTrust.output.includes("trusted moduleId must be present")) {
      throw new Error(
        `bogus trust failed for the wrong reason: ${bogusTrust.output}`,
      );
    }
    const bogusRegistration = await runValidator(bogusRegistrationDir);
    if (bogusRegistration.exitCode === 0) {
      throw new Error(
        "bogus registration report unexpectedly passed validation.",
      );
    }
    if (
      !bogusRegistration.output.includes(
        "trusted module must be present in sync.registeredModules",
      )
    ) {
      throw new Error(
        `bogus registration failed for the wrong reason: ${bogusRegistration.output}`,
      );
    }
    const duplicateModule = await runValidator(duplicateModuleDir);
    if (duplicateModule.exitCode === 0) {
      throw new Error(
        "duplicate module report unexpectedly passed validation.",
      );
    }
    if (
      !duplicateModule.output.includes("moduleIds must not contain duplicates")
    ) {
      throw new Error(
        `duplicate module failed for the wrong reason: ${duplicateModule.output}`,
      );
    }
    const duplicateRegisteredModule = await runValidator(
      duplicateRegisteredModuleDir,
    );
    if (duplicateRegisteredModule.exitCode === 0) {
      throw new Error(
        "duplicate registered module report unexpectedly passed validation.",
      );
    }
    if (
      !duplicateRegisteredModule.output.includes(
        "sync.registeredModules must not contain duplicates",
      )
    ) {
      throw new Error(
        `duplicate registered module failed for the wrong reason: ${duplicateRegisteredModule.output}`,
      );
    }
    const duplicateRegisteredPlugin = await runValidator(
      duplicateRegisteredPluginDir,
    );
    if (duplicateRegisteredPlugin.exitCode === 0) {
      throw new Error(
        "duplicate registered plugin report unexpectedly passed validation.",
      );
    }
    if (
      !duplicateRegisteredPlugin.output.includes(
        "sync.registered must not contain duplicates",
      )
    ) {
      throw new Error(
        `duplicate registered plugin failed for the wrong reason: ${duplicateRegisteredPlugin.output}`,
      );
    }
    const duplicateTrustDecision = await runValidator(
      duplicateTrustDecisionDir,
    );
    if (duplicateTrustDecision.exitCode === 0) {
      throw new Error(
        "duplicate trust decision report unexpectedly passed validation.",
      );
    }
    if (
      !duplicateTrustDecision.output.includes(
        "sync.trustDecisions must not contain duplicates",
      )
    ) {
      throw new Error(
        `duplicate trust decision failed for the wrong reason: ${duplicateTrustDecision.output}`,
      );
    }
    const registeredSkipped = await runValidator(registeredSkippedDir);
    if (registeredSkipped.exitCode === 0) {
      throw new Error(
        "registered skipped report unexpectedly passed validation.",
      );
    }
    if (
      !registeredSkipped.output.includes(
        "sync.skipped must not include plugins that are also registered",
      )
    ) {
      throw new Error(
        `registered skipped failed for the wrong reason: ${registeredSkipped.output}`,
      );
    }
    const registeredUnloaded = await runValidator(registeredUnloadedDir);
    if (registeredUnloaded.exitCode === 0) {
      throw new Error(
        "registered unloaded report unexpectedly passed validation.",
      );
    }
    if (
      !registeredUnloaded.output.includes(
        "sync.unloaded must not include plugins that are also registered",
      )
    ) {
      throw new Error(
        `registered unloaded failed for the wrong reason: ${registeredUnloaded.output}`,
      );
    }
    const skippedUnloadedOverlap = await runValidator(
      skippedUnloadedOverlapDir,
    );
    if (skippedUnloadedOverlap.exitCode === 0) {
      throw new Error(
        "skipped/unloaded overlap report unexpectedly passed validation.",
      );
    }
    if (
      !skippedUnloadedOverlap.output.includes(
        "sync.skipped must not include plugins that are also unloaded",
      )
    ) {
      throw new Error(
        `skipped/unloaded overlap failed for the wrong reason: ${skippedUnloadedOverlap.output}`,
      );
    }
    const skippedMissingTrust = await runValidator(skippedMissingTrustDir);
    if (skippedMissingTrust.exitCode === 0) {
      throw new Error(
        "skipped missing trust report unexpectedly passed validation.",
      );
    }
    if (
      !skippedMissingTrust.output.includes(
        "sync.skipped entries must have a rejected sync.trustDecisions entry",
      )
    ) {
      throw new Error(
        `skipped missing trust failed for the wrong reason: ${skippedMissingTrust.output}`,
      );
    }
    const duplicateSkipped = await runValidator(duplicateSkippedDir);
    if (duplicateSkipped.exitCode === 0) {
      throw new Error("duplicate skipped report unexpectedly passed.");
    }
    if (
      !duplicateSkipped.output.includes(
        "sync.skipped must not contain duplicates",
      )
    ) {
      throw new Error(
        `duplicate skipped failed for the wrong reason: ${duplicateSkipped.output}`,
      );
    }
    const duplicateUnloaded = await runValidator(duplicateUnloadedDir);
    if (duplicateUnloaded.exitCode === 0) {
      throw new Error("duplicate unloaded report unexpectedly passed.");
    }
    if (
      !duplicateUnloaded.output.includes(
        "sync.unloaded must not contain duplicates",
      )
    ) {
      throw new Error(
        `duplicate unloaded failed for the wrong reason: ${duplicateUnloaded.output}`,
      );
    }
    const exercisedUnregistered = await runValidator(exercisedUnregisteredDir);
    if (exercisedUnregistered.exitCode === 0) {
      throw new Error(
        "exercised unregistered report unexpectedly passed validation.",
      );
    }
    if (
      !exercisedUnregistered.output.includes(
        "every sync.registeredModules entry must have a trusted sync.trustDecisions entry",
      )
    ) {
      throw new Error(
        `exercised unregistered failed for the wrong reason: ${exercisedUnregistered.output}`,
      );
    }
    const registeredUnexercised = await runValidator(registeredUnexercisedDir);
    if (registeredUnexercised.exitCode === 0) {
      throw new Error(
        "registered unexercised report unexpectedly passed validation.",
      );
    }
    if (
      !registeredUnexercised.output.includes(
        "every sync.registeredModules moduleId must be exercised by conformance.exercised",
      )
    ) {
      throw new Error(
        `registered unexercised failed for the wrong reason: ${registeredUnexercised.output}`,
      );
    }
    const missingSummaryModuleExercise = await runValidator(
      missingSummaryModuleExerciseDir,
    );
    if (missingSummaryModuleExercise.exitCode === 0) {
      throw new Error(
        "missing summary module exercise report unexpectedly passed validation.",
      );
    }
    if (
      !missingSummaryModuleExercise.output.includes(
        "moduleExercises must include conformance.exercised.action",
      )
    ) {
      throw new Error(
        `missing summary module exercise failed for the wrong reason: ${missingSummaryModuleExercise.output}`,
      );
    }
    const duplicateModuleExercise = await runValidator(
      duplicateModuleExerciseDir,
    );
    if (duplicateModuleExercise.exitCode === 0) {
      throw new Error(
        "duplicate module exercise report unexpectedly passed validation.",
      );
    }
    if (
      !duplicateModuleExercise.output.includes(
        "conformance.moduleExercises must not contain duplicates",
      )
    ) {
      throw new Error(
        `duplicate module exercise failed for the wrong reason: ${duplicateModuleExercise.output}`,
      );
    }
    const missingModuleExercises = await runValidator(
      missingModuleExercisesDir,
    );
    if (missingModuleExercises.exitCode === 0) {
      throw new Error(
        "missing moduleExercises report unexpectedly passed validation.",
      );
    }
    if (
      !missingModuleExercises.output.includes(
        "conformance.moduleExercises must be an array",
      )
    ) {
      throw new Error(
        `missing moduleExercises failed for the wrong reason: ${missingModuleExercises.output}`,
      );
    }
    const missingRpcCalls = await runValidator(missingRpcCallsDir);
    if (missingRpcCalls.exitCode === 0) {
      throw new Error("missing rpcCalls report unexpectedly passed.");
    }
    if (
      !missingRpcCalls.output.includes("conformance.rpcCalls must be an array")
    ) {
      throw new Error(
        `missing rpcCalls failed for the wrong reason: ${missingRpcCalls.output}`,
      );
    }
    const invalidRpcMethod = await runValidator(invalidRpcMethodDir);
    if (invalidRpcMethod.exitCode === 0) {
      throw new Error("invalid rpc method report unexpectedly passed.");
    }
    if (
      !invalidRpcMethod.output.includes(
        "conformance.rpcCalls[0].method must be valid for its surface.",
      )
    ) {
      throw new Error(
        `invalid rpc method failed for the wrong reason: ${invalidRpcMethod.output}`,
      );
    }
    const missingRequiredRpcMethod = await runValidator(
      missingRequiredRpcMethodDir,
    );
    if (missingRequiredRpcMethod.exitCode === 0) {
      throw new Error("missing required rpc method report unexpectedly passed.");
    }
    if (
      !missingRequiredRpcMethod.output.includes(
        "conformance.rpcCalls must include every required method for each conformance.moduleExercises entry.",
      )
    ) {
      throw new Error(
        `missing required rpc method failed for the wrong reason: ${missingRequiredRpcMethod.output}`,
      );
    }
    const missingRuntimeRemotePlugin = await runValidator(
      missingRuntimeRemotePluginDir,
    );
    if (missingRuntimeRemotePlugin.exitCode === 0) {
      throw new Error(
        "missing runtime remote plugin report unexpectedly passed validation.",
      );
    }
    if (
      !missingRuntimeRemotePlugin.output.includes(
        "runtime.remotePlugins must include every sync.registeredModules entry",
      )
    ) {
      throw new Error(
        `missing runtime remote plugin failed for the wrong reason: ${missingRuntimeRemotePlugin.output}`,
      );
    }
    const staleRuntimeRemotePlugin = await runValidator(
      staleRuntimeRemotePluginDir,
    );
    if (staleRuntimeRemotePlugin.exitCode === 0) {
      throw new Error(
        "stale runtime remote plugin report unexpectedly passed validation.",
      );
    }
    if (
      !staleRuntimeRemotePlugin.output.includes(
        "runtime.remotePlugins must not include entries absent from sync.registeredModules",
      )
    ) {
      throw new Error(
        `stale runtime remote plugin failed for the wrong reason: ${staleRuntimeRemotePlugin.output}`,
      );
    }
    const manifestOnlyUnregistered = await runValidator(
      manifestOnlyUnregisteredDir,
    );
    if (manifestOnlyUnregistered.exitCode === 0) {
      throw new Error(
        "manifest-only unregistered report unexpectedly passed validation.",
      );
    }
    if (
      !manifestOnlyUnregistered.output.includes(
        "every conformance.moduleIds entry must be present in sync.registeredModules",
      )
    ) {
      throw new Error(
        `manifest-only unregistered failed for the wrong reason: ${manifestOnlyUnregistered.output}`,
      );
    }
    const runtimeUndercount = await runValidator(runtimeUndercountDir);
    if (runtimeUndercount.exitCode === 0) {
      throw new Error("runtime undercount report unexpectedly passed.");
    }
    if (!runtimeUndercount.output.includes("runtime.actionCount")) {
      throw new Error(
        `runtime undercount failed for the wrong reason: ${runtimeUndercount.output}`,
      );
    }
    const runtimePluginUndercount = await runValidator(
      runtimePluginUndercountDir,
    );
    if (runtimePluginUndercount.exitCode === 0) {
      throw new Error("runtime plugin undercount report unexpectedly passed.");
    }
    if (!runtimePluginUndercount.output.includes("runtime.pluginCount")) {
      throw new Error(
        `runtime plugin undercount failed for the wrong reason: ${runtimePluginUndercount.output}`,
      );
    }
    const missingRegisteredService = await runValidator(
      missingRegisteredServiceDir,
    );
    if (missingRegisteredService.exitCode === 0) {
      throw new Error(
        "missing registered service report unexpectedly passed validation.",
      );
    }
    if (
      !missingRegisteredService.output.includes(
        "sync.registeredModules aggregate serviceCount must be greater than zero",
      )
    ) {
      throw new Error(
        `missing registered service failed for the wrong reason: ${missingRegisteredService.output}`,
      );
    }
    const missingEvaluator = await runValidator(missingEvaluatorDir);
    if (missingEvaluator.exitCode === 0) {
      throw new Error(
        "missing evaluator materialization report unexpectedly passed validation.",
      );
    }
    if (!missingEvaluator.output.includes("runtime.evaluatorCount")) {
      throw new Error(
        `missing evaluator materialization failed for the wrong reason: ${missingEvaluator.output}`,
      );
    }
    const missingEvent = await runValidator(missingEventDir);
    if (missingEvent.exitCode === 0) {
      throw new Error(
        "missing event materialization report unexpectedly passed.",
      );
    }
    if (!missingEvent.output.includes("runtime.eventCount")) {
      throw new Error(
        `missing event materialization failed for the wrong reason: ${missingEvent.output}`,
      );
    }
    const missingService = await runValidator(missingServiceDir);
    if (missingService.exitCode === 0) {
      throw new Error(
        "missing service materialization report unexpectedly passed validation.",
      );
    }
    if (!missingService.output.includes("runtime.serviceCount")) {
      throw new Error(
        `missing service materialization failed for the wrong reason: ${missingService.output}`,
      );
    }
    const missingApp = await runValidator(missingAppDir);
    if (missingApp.exitCode === 0) {
      throw new Error("missing app materialization report unexpectedly passed.");
    }
    if (!missingApp.output.includes("runtime.appCount")) {
      throw new Error(
        `missing app materialization failed for the wrong reason: ${missingApp.output}`,
      );
    }
    const missingFieldEvaluator = await runValidator(missingFieldEvaluatorDir);
    if (missingFieldEvaluator.exitCode === 0) {
      throw new Error(
        "missing field evaluator materialization report unexpectedly passed validation.",
      );
    }
    if (
      !missingFieldEvaluator.output.includes(
        "runtime.responseHandlerFieldEvaluatorCount",
      )
    ) {
      throw new Error(
        `missing field evaluator materialization failed for the wrong reason: ${missingFieldEvaluator.output}`,
      );
    }

    console.log("Capability-router live report validator self-test passed.");
  } finally {
    await rm(workspace, { force: true, recursive: true });
  }
}

function makeCompleteReport(
  kind: "cloud" | "provider",
  endpointId = "sample-endpoint",
  provider = "e2b",
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
    actionResult: {},
    providerResult: {},
    routeResult: { status: 200 },
    assetResult: {
      path: "/assets/sample.js",
      contentType: "text/javascript",
      manifestContentType: "text/javascript",
      byteLength: 12,
      sha256:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    },
    modelResult: {},
    lifecycleResult: {},
    eventResult: {},
    serviceResult: {},
    appBridgeResult: {},
    evaluatorResult: {
      shouldRun: { shouldRun: true },
      prepare: {},
      prompt: { prompt: "sample prompt" },
      process: {},
    },
    responseHandlerEvaluatorResult: {
      shouldRun: { shouldRun: true },
      evaluate: {},
    },
    responseHandlerFieldEvaluatorResult: {
      shouldRun: { shouldRun: true },
      parse: {},
      handle: {},
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
    provider: "e2b",
    endpointUrlSha256: makeEndpointUrlSha256("partial-endpoint", "e2b"),
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
    ...makeCompleteReport("provider", "missing-fingerprint-endpoint", "e2b"),
  } as Record<string, unknown>;
  delete report.endpointUrlSha256;
  return report;
}

function makeMalformedEndpointUrlFingerprintReport() {
  return {
    ...makeCompleteReport("provider", "malformed-fingerprint-endpoint", "e2b"),
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
