/**
 * Coordinates one externally hosted provider canary without implementing or
 * impersonating any provider boundary. Every effectful capability is injected
 * by the operator, while this module owns authorization, ordering, correlation,
 * qualification, cleanup, and the final publication gate.
 */

import type { ScenarioDefinition } from "@elizaos/scenario-runner/schema";
import type { ScenarioReport } from "../types.ts";
import type { ProviderOperationKind } from "./operation-binding.ts";
import {
  type AuthorizedProviderCanaryExecutionPreflight,
  type ProviderCanaryAuthorization,
  type ProviderFailureProbeMaterial,
  preflightAuthorizedProviderCanaryExecution,
} from "./operator-authorization.ts";
import type {
  SignedProviderObserverEvidence,
  SignedSemanticJudgeEvidence,
} from "./qualification.ts";
import {
  assembleProviderQualificationArtifact,
  type ProviderQualificationArtifact,
  reverifyProviderQualificationArtifact,
} from "./qualification-artifact.ts";
import type { VerifiedScenarioTrajectorySet } from "./trajectory-verifier.ts";

export type ExternalProviderCanaryStage =
  | "authorization-validated"
  | "observer-started"
  | "ingress-completed"
  | "trajectories-verified"
  | "observer-evidence-completed"
  | "semantic-judgment-completed"
  | "artifact-reverified"
  | "cleanup-completed"
  | "published";

export interface ExternalProviderCanaryContext {
  scenario: ScenarioDefinition;
  preflight: AuthorizedProviderCanaryExecutionPreflight;
  providerTarget: unknown;
  operationInput: unknown;
  failureProbes: readonly [
    ProviderFailureProbeMaterial,
    ProviderFailureProbeMaterial,
    ...ProviderFailureProbeMaterial[],
  ];
}

export interface AuthenticatedProviderIngressResult {
  runnerReport: ScenarioReport;
}

export interface ExternalProviderObserverSession {
  complete(input: {
    context: ExternalProviderCanaryContext;
    ingress: AuthenticatedProviderIngressResult;
    trajectories: VerifiedScenarioTrajectorySet;
  }): Promise<SignedProviderObserverEvidence>;
}

export interface ExternalProviderCanaryCapabilities {
  observer: {
    begin(
      context: ExternalProviderCanaryContext,
    ): Promise<ExternalProviderObserverSession>;
  };
  ingress: {
    execute(
      context: ExternalProviderCanaryContext,
    ): Promise<AuthenticatedProviderIngressResult>;
  };
  trajectories: {
    verify(input: {
      context: ExternalProviderCanaryContext;
      ingress: AuthenticatedProviderIngressResult;
    }): Promise<VerifiedScenarioTrajectorySet>;
  };
  semanticJudge: {
    judge(input: {
      context: ExternalProviderCanaryContext;
      ingress: AuthenticatedProviderIngressResult;
      trajectories: VerifiedScenarioTrajectorySet;
      observerEvidence: SignedProviderObserverEvidence;
    }): Promise<SignedSemanticJudgeEvidence>;
  };
  cleanup: {
    cleanup(input: {
      context: ExternalProviderCanaryContext;
      completedStages: readonly ExternalProviderCanaryStage[];
      artifact?: ProviderQualificationArtifact;
      failure?: unknown;
    }): Promise<void>;
  };
  publisher: {
    publish(artifact: ProviderQualificationArtifact): Promise<void>;
  };
}

export interface ExecuteExternalProviderCanaryInput {
  scenario: ScenarioDefinition;
  authorization: ProviderCanaryAuthorization;
  pinnedManifestAuthorityPublicKeysPem: readonly [string, ...string[]];
  operationKind: ProviderOperationKind;
  providerTarget: unknown;
  operationInput: unknown;
  failureProbes: readonly [
    ProviderFailureProbeMaterial,
    ProviderFailureProbeMaterial,
    ...ProviderFailureProbeMaterial[],
  ];
  pinnedObserverPublicKeysPem: readonly [string, ...string[]];
  pinnedSemanticJudgePublicKeysPem: readonly [string, ...string[]];
  capabilities: ExternalProviderCanaryCapabilities;
  now?: () => Date;
  maxSignatureAgeMs?: number;
  maxClockSkewMs?: number;
}

export interface ExternalProviderCanaryResult {
  artifact: ProviderQualificationArtifact;
  completedStages: readonly ExternalProviderCanaryStage[];
}

function requireFunction(value: unknown, path: string): void {
  if (typeof value !== "function") {
    throw new Error(
      `external provider-canary capability ${path} is required before ingress`,
    );
  }
}

function preflightCapabilities(
  capabilities: ExternalProviderCanaryCapabilities,
): void {
  requireFunction(capabilities?.observer?.begin, "observer.begin");
  requireFunction(capabilities?.ingress?.execute, "ingress.execute");
  requireFunction(capabilities?.trajectories?.verify, "trajectories.verify");
  requireFunction(capabilities?.semanticJudge?.judge, "semanticJudge.judge");
  requireFunction(capabilities?.cleanup?.cleanup, "cleanup.cleanup");
  requireFunction(capabilities?.publisher?.publish, "publisher.publish");
}

function requireCorrelation(
  context: ExternalProviderCanaryContext,
  ingress: AuthenticatedProviderIngressResult,
  trajectories: VerifiedScenarioTrajectorySet,
  observerEvidence: SignedProviderObserverEvidence,
  semanticEvidence: SignedSemanticJudgeEvidence,
): void {
  const manifest = context.preflight.authorization.manifest;
  const expected = {
    scenarioId: context.scenario.id,
    runId: manifest.run.runId,
    runNonce: manifest.run.nonce,
    manifestSha256: manifest.manifestSha256,
  };
  if (
    ingress.runnerReport.id !== expected.scenarioId ||
    trajectories.scenarioId !== expected.scenarioId ||
    trajectories.runId !== expected.runId ||
    observerEvidence.payload.scenarioId !== expected.scenarioId ||
    observerEvidence.payload.runId !== expected.runId ||
    observerEvidence.payload.runNonce !== expected.runNonce ||
    observerEvidence.payload.manifestSha256 !== expected.manifestSha256 ||
    observerEvidence.payload.trajectorySetSha256 !== trajectories.setSha256 ||
    semanticEvidence.payload.scenarioId !== expected.scenarioId ||
    semanticEvidence.payload.runId !== expected.runId ||
    semanticEvidence.payload.runNonce !== expected.runNonce ||
    semanticEvidence.payload.manifestSha256 !== expected.manifestSha256 ||
    semanticEvidence.payload.trajectorySetSha256 !== trajectories.setSha256
  ) {
    throw new Error(
      "external provider-canary collaborator output is not correlated to the authorized run",
    );
  }
}

/**
 * Execute one authorized provider canary and publish only after every external
 * proof has been assembled, independently reverified, and safely cleaned up.
 */
export async function executeExternalProviderCanary(
  input: ExecuteExternalProviderCanaryInput,
): Promise<ExternalProviderCanaryResult> {
  const preflight = preflightAuthorizedProviderCanaryExecution({
    scenario: input.scenario,
    authorization: input.authorization,
    pinnedManifestAuthorityPublicKeysPem:
      input.pinnedManifestAuthorityPublicKeysPem,
    operationKind: input.operationKind,
    providerTarget: input.providerTarget,
    operationInput: input.operationInput,
    failureProbes: input.failureProbes,
  });
  const completedStages: ExternalProviderCanaryStage[] = [
    "authorization-validated",
  ];
  preflightCapabilities(input.capabilities);

  const context: ExternalProviderCanaryContext = {
    scenario: input.scenario,
    preflight,
    providerTarget: input.providerTarget,
    operationInput: input.operationInput,
    failureProbes: input.failureProbes,
  };
  let failure: unknown;
  let artifact: ProviderQualificationArtifact | undefined;
  try {
    const observer = await input.capabilities.observer.begin(context);
    requireFunction(observer?.complete, "observer session complete");
    completedStages.push("observer-started");

    const ingress = await input.capabilities.ingress.execute(context);
    completedStages.push("ingress-completed");
    const trajectories = await input.capabilities.trajectories.verify({
      context,
      ingress,
    });
    completedStages.push("trajectories-verified");
    const observerEvidence = await observer.complete({
      context,
      ingress,
      trajectories,
    });
    completedStages.push("observer-evidence-completed");
    const semanticEvidence = await input.capabilities.semanticJudge.judge({
      context,
      ingress,
      trajectories,
      observerEvidence,
    });
    completedStages.push("semantic-judgment-completed");
    requireCorrelation(
      context,
      ingress,
      trajectories,
      observerEvidence,
      semanticEvidence,
    );
    artifact = assembleProviderQualificationArtifact({
      scenarioDefinition: input.scenario,
      manifest: preflight.authorization.manifest,
      manifestSignature: preflight.authorization.manifestSignature,
      pinnedManifestAuthorityPublicKeysPem:
        input.pinnedManifestAuthorityPublicKeysPem,
      trajectories,
      signedEvidence: observerEvidence,
      pinnedObserverPublicKeysPem: input.pinnedObserverPublicKeysPem,
      signedSemanticEvidence: semanticEvidence,
      pinnedSemanticJudgePublicKeysPem: input.pinnedSemanticJudgePublicKeysPem,
      runnerReport: ingress.runnerReport,
      nowIso: (input.now ?? (() => new Date()))().toISOString(),
      ...(input.maxSignatureAgeMs === undefined
        ? {}
        : { maxSignatureAgeMs: input.maxSignatureAgeMs }),
      ...(input.maxClockSkewMs === undefined
        ? {}
        : { maxClockSkewMs: input.maxClockSkewMs }),
    });
    reverifyProviderQualificationArtifact(artifact);
    if (!artifact.decision.qualification.publishable) {
      throw new Error(
        `external provider-canary qualification is not publishable: ${artifact.decision.qualification.reasons.join("; ")}`,
      );
    }
    completedStages.push("artifact-reverified");
  } catch (error) {
    // error-policy:J2 Preserve the execution failure while cleanup runs below.
    failure = error;
  }

  try {
    await input.capabilities.cleanup.cleanup({
      context,
      completedStages: [...completedStages],
      ...(artifact === undefined ? {} : { artifact }),
      ...(failure === undefined ? {} : { failure }),
    });
    completedStages.push("cleanup-completed");
  } catch (cleanupError) {
    // error-policy:J2 Cleanup is a publication prerequisite; retain both causes.
    throw failure === undefined
      ? new Error("external provider-canary cleanup failed", {
          cause: cleanupError,
        })
      : new AggregateError(
          [failure, cleanupError],
          "external provider-canary execution and cleanup failed",
        );
  }
  if (failure !== undefined) {
    throw failure;
  }
  if (artifact === undefined) {
    throw new Error("external provider-canary artifact was not assembled");
  }

  await input.capabilities.publisher.publish(artifact);
  completedStages.push("published");
  return Object.freeze({
    artifact,
    completedStages: Object.freeze([...completedStages]),
  });
}
