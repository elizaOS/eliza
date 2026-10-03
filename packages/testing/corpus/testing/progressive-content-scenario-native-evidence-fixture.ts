/** Builds closed, privacy-attested native scenario rows for evidence-validator tests. */

const privacyAttestation = {
  schema: "eliza.privacy_filter_attestation.v1",
  version: 1,
  source: "scenario_native_export",
  redacted: true,
  reviewed: true,
  passed: true,
  attestationPath: "scenario-native.privacy-attestation.json",
} as const;

const stages = [
  {
    stepType: "messageHandler",
    purpose: "messageHandler",
    modelType: "RESPONSE_HANDLER",
    provider: "deterministic-model-provider",
    taskType: "should_respond",
    stepIndex: 0,
    response: { text: '{"contexts":["code"]}' },
  },
  {
    stepType: "planner",
    purpose: "planner",
    modelType: "ACTION_PLANNER",
    provider: null,
    taskType: "action_planner",
    stepIndex: 2,
    response: {
      text: '{"finishReason":"tool-calls"}',
      toolCalls: [{ toolName: "FILE", input: { action: "read", offset: 0 } }],
    },
  },
  {
    stepType: "evaluation",
    purpose: "evaluation",
    modelType: "RESPONSE_HANDLER",
    provider: "deterministic-model-provider",
    taskType: "evaluation",
    stepIndex: 4,
    response: {
      text: JSON.stringify({
        success: true,
        decision: "FINISH",
        messageToUser: "Done.",
      }),
    },
  },
] as const;

/** Return the exact three-row native export emitted by the deterministic scenario lane. */
export function createProgressiveContentScenarioNativeEvidenceFixture(): string {
  return `${stages
    .map((stage, index) => {
      const stepId = `stage-${stage.stepType}-${index}`;
      const metadata = {
        task_type: stage.taskType,
        source_dataset: "scenario_trajectory_boundary",
        trajectory_id: "trajectory-progressive-content",
        step_id: stepId,
        call_id: `trajectory-progressive-content:${stepId}`,
        agent_id: "00000000-0000-4000-8000-000000000001",
        source_run_id: "content-context-fixture",
        source_room_id: "00000000-0000-4000-8000-000000000002",
        scenario_id: "deterministic-progressive-content-actions",
        source_stage_kind: stage.stepType,
        ...(stage.stepType === "planner" || stage.stepType === "evaluation"
          ? { source_stage_iteration: 1 }
          : {}),
        source_model_type: stage.modelType,
        ...(stage.stepType === "planner"
          ? {}
          : { source_provider: stage.provider }),
        trajectory_status: "finished",
        scenario_status: "passed",
        privacy_attestation: privacyAttestation,
      };
      return JSON.stringify({
        format: "eliza_native_v1",
        schemaVersion: 1,
        boundary: "vercel_ai_sdk.generateText",
        scenarioStatus: "passed",
        request: {
          messages: [{ role: "user", content: "Read the seeded content." }],
          providerOptions: {},
          ...(stage.stepType === "evaluation"
            ? {}
            : { toolChoice: "required" }),
          tools: [],
        },
        response: stage.response,
        metadata,
        privacyAttestation,
        agentId: "00000000-0000-4000-8000-000000000001",
        batchId: null,
        callId: `trajectory-progressive-content:${stepId}`,
        callIndex: 0,
        modelType: stage.modelType,
        provider: stage.provider,
        purpose: stage.purpose,
        scenarioId: "deterministic-progressive-content-actions",
        stepId,
        stepIndex: stage.stepIndex,
        stepType: stage.stepType,
        timestamp: 1_787_643_047_398 + index,
        trajectoryId: "trajectory-progressive-content",
      });
    })
    .join("\n")}\n`;
}
