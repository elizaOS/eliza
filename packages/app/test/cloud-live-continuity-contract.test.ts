/** Unit coverage for the privacy-safe Cloud history-continuity contract. */

import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertCloudLiveNamedWarmingMode,
  assertCloudLiveNamedWarmingProof,
  type CloudLiveContinuityEvidenceInput,
  classifyForbiddenAgentMutation,
  compareCloudLiveRuntimeBindings,
  createCloudLiveContinuityEvidence,
  createCloudLiveHistoryNetworkDiagnostics,
  createCloudLiveNetworkAudit,
  installCloudLiveAnchoredRetryChipObserver,
  parseCloudLiveContinuityEvidence,
  readCloudLiveBoundedResponseBody,
  readCloudLiveContinuityEvidence,
  writeCloudLiveContinuityEvidence,
} from "./cloud-live-continuity-contract";

const { JSDOM } = createRequire(import.meta.url)("jsdom") as {
  JSDOM: new (html?: string) => { window: { document: Document } };
};

const textEncoder = new TextEncoder();

function boundedJsonBody(
  value: unknown,
  options: {
    contentType?: string;
    raw?: string;
    ignoreBudget?: boolean;
    reject?: boolean;
  } = {},
) {
  const bytes = textEncoder.encode(options.raw ?? JSON.stringify(value));
  const budgets: number[] = [];
  return {
    budgets,
    responseBody: {
      contentType: options.contentType ?? "application/json; charset=utf-8",
      async read(maxBytes: number) {
        budgets.push(maxBytes);
        if (options.reject) throw new Error("body unavailable");
        if (!options.ignoreBudget && bytes.byteLength > maxBytes) return null;
        return bytes;
      },
    },
  };
}

const temporaryDirectories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function passingInput(): CloudLiveContinuityEvidenceInput {
  const history = {
    historyGetSucceeded: true,
    challengeUserLinePresent: true,
    challengeAssistantLinePresent: true,
  } as const;
  return {
    challengeTurnCount: 1,
    noAdditionalChatSendAfterChallenge: true,
    personalIdentityEndpointPassed: true,
    reload: history,
    freshContext: {
      ...history,
      createdWithoutStorageState: true,
      serviceWorkersBlocked: true,
    },
    bindingReuse: {
      personalIdentityReused: true,
      runtimeBindingReused: true,
      apiBaseReused: true,
    },
    dedicatedMutationProof: {
      approvalGrantedCount: 0,
      confirmationClickCount: 0,
      confirmationKind: "none",
      adoptionConfirmationPostCount: 0,
      activationPostCount: 0,
      cutoverPostCount: 0,
      forbiddenAgentMutationCount: 0,
      approvalBindingPresent: false,
      lifecycleBindingMismatchCount: 0,
    },
    cleanupDisposition: "no-test-owned-agent",
    conversationHistoryDisposition: "preserved",
  };
}

describe("forbidden Cloud agent mutations", () => {
  it("matches only the bounded lifecycle set on observable client paths", () => {
    for (const [method, path, expected] of [
      ["POST", "/api/v1/eliza/agents", "create"],
      ["POST", "/api/cloud/v1/eliza/agents", "create"],
      ["POST", "/api/compat/agents", "create"],
      ["POST", "/api/cloud/compat/agents", "create"],
      ["POST", "/api/cloud/agents", "create"],
      ["POST", "/api/v1/eliza/agents/a%2Fb/provision", "provision"],
      ["POST", "/api/cloud/v1/eliza/agents/a%2Fb/provision", "provision"],
      ["POST", "/api/cloud/agents/a%2Fb/provision", "provision"],
      ["POST", "/api/cloud/agents/a%2Fb/connect", "provision"],
      ["POST", "/api/compat/agents/a%2Fb/launch", "provision"],
      ["POST", "/api/cloud/compat/agents/a%2Fb/launch", "provision"],
      ["POST", "/api/v1/eliza/agents/a%2Fb/upgrade-tier", "upgrade-tier"],
      ["POST", "/api/cloud/v1/eliza/agents/a%2Fb/upgrade-tier", "upgrade-tier"],
      [
        "POST",
        "/api/v1/eliza/agents/a%2Fb/upgrade-tier/cutover",
        "upgrade-tier-cutover",
      ],
      [
        "POST",
        "/api/cloud/v1/eliza/agents/a%2Fb/upgrade-tier/cutover",
        "upgrade-tier-cutover",
      ],
      ["DELETE", "/api/v1/eliza/agents/a%2Fb", "delete"],
      ["DELETE", "/api/cloud/v1/eliza/agents/a%2Fb", "delete"],
      ["DELETE", "/api/compat/agents/a%2Fb", "delete"],
      ["DELETE", "/api/cloud/compat/agents/a%2Fb", "delete"],
      ["POST", "/api/cloud/agents/a%2Fb/shutdown", "delete"],
    ] as const) {
      expect(classifyForbiddenAgentMutation(method, path)).toBe(expected);
    }
  });

  it("never counts chat, safe actions, wrong verbs, or lookalike routes", () => {
    const agent = "https://api.test/api/v1/eliza/agents/private";
    for (const [method, suffix] of [
      ["POST", "/api/conversations/private/messages"],
      ["POST", "/api/conversations/private/messages/stream"],
      ["POST", "/resume"],
      ["POST", "/sleep"],
      ["POST", "/snapshot"],
      ["POST", "/write"],
      ["GET", "/provision"],
      ["DELETE", "/api/conversations/private"],
      ["POST", "/upgrade-tier/cutover/extra"],
    ] as const) {
      expect(
        classifyForbiddenAgentMutation(method, `${agent}${suffix}`),
      ).toBeNull();
    }
    expect(
      classifyForbiddenAgentMutation(
        "POST",
        "https://api.test/api/v1/eliza/personal",
      ),
    ).toBeNull();
    for (const [method, path] of [
      ["POST", "/api/compat/agents/id/provision"],
      ["POST", "/api/cloud/compat/agents/id/provision"],
      ["GET", "/api/compat/agents/id/launch"],
      ["DELETE", "/api/cloud/compat/agents/id/launch"],
      ["POST", "/api/compat/agents/id/launch/extra"],
      ["POST", "/api/cloud/compat/agents/id/launch/extra"],
      ["POST", "/api/cloud/agents/id/shutdown/extra"],
      ["POST", "/api/cloud/agents/id/write"],
    ] as const) {
      expect(classifyForbiddenAgentMutation(method, path)).toBeNull();
    }
  });

  it("reduces retry attempts with one clientMessageId to one logical send", async () => {
    const audit = createCloudLiveNetworkAudit();
    const history =
      "https://api.test/api/v1/eliza/agents/private/api/conversations/private/messages";
    audit.observeRequest("GET", history);
    audit.observeResponse("GET", history, 200);
    audit.observeRequest("GET", "/api/v1/eliza/personal");
    audit.observeResponse("GET", "/api/v1/eliza/personal", 200);
    const firstLogicalTurn = JSON.stringify({
      text: "private prompt",
      clientMessageId: "private-idempotency-key",
    });
    audit.observeRequest("POST", `${history}/stream`, firstLogicalTurn);
    audit.observeRequest("POST", `${history}/stream`, firstLogicalTurn);
    audit.observeResponse("POST", `${history}/stream`, 202);
    audit.observeResponse("POST", `${history}/stream`, 503);
    audit.observeResponse("POST", `${history}/stream`, 409);
    audit.observeResponse("POST", `${history}/stream`, 302);
    audit.observeRequest(
      "POST",
      `${history.replace("/private/messages", "/other/messages")}/stream`,
      firstLogicalTurn,
    );
    audit.observeRequest(
      "POST",
      `${history}/stream`,
      JSON.stringify({ clientMessageId: "second-private-id" }),
    );
    audit.observeRequest("POST", `${history}/stream`, "not-json");
    audit.observeRequest(
      "POST",
      "https://api.test/api/v1/eliza/agents/private/provision",
    );
    const snapshot = await audit.snapshot();
    expect(snapshot).toEqual({
      forbiddenAgentMutationCount: 1,
      chatSendAttemptCount: 5,
      logicalChatSendCount: 3,
      unidentifiedChatSendAttemptCount: 1,
      namedWarmingResponseCount: 0,
      successfulChatSendResponseCount: 1,
      clientErrorChatSendResponseCount: 1,
      serverErrorChatSendResponseCount: 1,
      otherChatSendResponseCount: 1,
      personalIdentityGetRequestCount: 1,
      successfulPersonalIdentityGetCount: 1,
      clientErrorPersonalIdentityGetResponseCount: 0,
      serverErrorPersonalIdentityGetResponseCount: 0,
      otherPersonalIdentityGetResponseCount: 0,
      failedPersonalIdentityGetRequestCount: 0,
      pendingPersonalIdentityGetRequestCount: 0,
      completedPersonalIdentityResponseBodyCount: 0,
      parsedPersonalIdentityResponseBodyCount: 0,
      decodedSharedPersonalIdentityResponseCount: 0,
      decodedDedicatedPersonalIdentityResponseCount: 0,
      uninspectablePersonalIdentityResponseBodyCount: 1,
      dedicatedQuoteGetRequestCount: 0,
      successfulDedicatedQuoteGetResponseCount: 0,
      clientErrorDedicatedQuoteGetResponseCount: 0,
      serverErrorDedicatedQuoteGetResponseCount: 0,
      otherDedicatedQuoteGetResponseCount: 0,
      failedDedicatedQuoteGetRequestCount: 0,
      pendingDedicatedQuoteGetRequestCount: 0,
      completedDedicatedQuoteResponseBodyCount: 0,
      parsedDedicatedQuoteResponseBodyCount: 0,
      decodedDedicatedQuoteResponseCount: 0,
      uninspectableDedicatedQuoteResponseBodyCount: 0,
      dedicatedActivationPostRequestCount: 0,
      successfulDedicatedActivationPostResponseCount: 0,
      clientErrorDedicatedActivationPostResponseCount: 0,
      serverErrorDedicatedActivationPostResponseCount: 0,
      otherDedicatedActivationPostResponseCount: 0,
      failedDedicatedActivationPostRequestCount: 0,
      pendingDedicatedActivationPostRequestCount: 0,
      completedDedicatedActivationResponseBodyCount: 0,
      parsedDedicatedActivationResponseBodyCount: 0,
      decodedDedicatedActivationReceiptCount: 0,
      uninspectableDedicatedActivationResponseBodyCount: 0,
      dedicatedActivationResponseStatus: null,
      dedicatedActivationResponseCode: null,
      dedicatedCutoverPostRequestCount: 0,
      successfulDedicatedCutoverPostResponseCount: 0,
      clientErrorDedicatedCutoverPostResponseCount: 0,
      serverErrorDedicatedCutoverPostResponseCount: 0,
      otherDedicatedCutoverPostResponseCount: 0,
      failedDedicatedCutoverPostRequestCount: 0,
      pendingDedicatedCutoverPostRequestCount: 0,
      completedDedicatedCutoverResponseBodyCount: 0,
      parsedDedicatedCutoverResponseBodyCount: 0,
      decodedDedicatedCutoverPendingResponseCount: 0,
      decodedDedicatedCutoverFinalResponseCount: 0,
      uninspectableDedicatedCutoverResponseBodyCount: 0,
      dedicatedAdoptionQuoteGetRequestCount: 0,
      successfulDedicatedAdoptionQuoteGetResponseCount: 0,
      clientErrorDedicatedAdoptionQuoteGetResponseCount: 0,
      serverErrorDedicatedAdoptionQuoteGetResponseCount: 0,
      otherDedicatedAdoptionQuoteGetResponseCount: 0,
      failedDedicatedAdoptionQuoteGetRequestCount: 0,
      pendingDedicatedAdoptionQuoteGetRequestCount: 0,
      completedDedicatedAdoptionQuoteResponseBodyCount: 0,
      parsedDedicatedAdoptionQuoteResponseBodyCount: 0,
      decodedAdoptableDedicatedAdoptionQuoteCount: 0,
      decodedUnavailableDedicatedAdoptionQuoteCount: 0,
      uninspectableDedicatedAdoptionQuoteResponseBodyCount: 0,
      dedicatedAdoptionConfirmationPostRequestCount: 0,
      dedicatedApprovalBindingPresent: false,
      dedicatedLifecycleBindingMismatchCount: 0,
      historyGetRequestCount: 1,
      successfulHistoryGetCount: 1,
      clientErrorHistoryGetResponseCount: 0,
      serverErrorHistoryGetResponseCount: 0,
      otherHistoryGetResponseCount: 0,
      failedHistoryGetRequestCount: 0,
      timedOutHistoryGetRequestCount: 0,
      pendingHistoryGetRequestCount: 0,
      inspectedHistoryResponseCount: 0,
      uninspectableHistoryResponseCount: 0,
      historyResponseWithAnchorUserCount: 0,
      historyResponseWithAnchoredAssistantCount: 0,
    });
    expect(JSON.stringify(snapshot)).not.toMatch(
      /api\.test|private|idempotency|prompt/,
    );
  });

  it("reduces pre-identity request outcomes to closed counters", async () => {
    const audit = createCloudLiveNetworkAudit();
    const personal = "https://api.test/api/v1/eliza/personal";
    for (const status of [200, 404, 503, 302]) {
      audit.observeRequest("GET", personal);
      audit.observeResponse(
        "GET",
        personal,
        status,
        status === 200
          ? boundedJsonBody({
              success: true,
              data: { identity: { runtime: "shared", id: "private" } },
            }).responseBody
          : undefined,
      );
    }
    audit.observeRequest("GET", personal);
    audit.observeRequestFailure("GET", personal, "private timeout detail");
    audit.observeRequest("GET", personal);
    const upgrade =
      "https://api.test/api/v1/eliza/agents/private-target/upgrade-tier";
    audit.observeRequest("GET", upgrade);
    audit.observeResponse(
      "GET",
      upgrade,
      200,
      boundedJsonBody({
        success: true,
        data: {
          quoteId: "private-quote",
          activation: { state: "available" },
        },
      }).responseBody,
    );
    audit.observeRequest("POST", upgrade);
    audit.observeResponse(
      "POST",
      upgrade,
      202,
      boundedJsonBody({
        success: true,
        data: { dedicatedAgentId: "private-target" },
      }).responseBody,
    );
    audit.observeRequest("POST", `${upgrade}/cutover`);
    audit.observeResponse(
      "POST",
      `${upgrade}/cutover`,
      409,
      boundedJsonBody({ success: false, code: "private-pending" }).responseBody,
    );
    audit.observeRequest("POST", `${upgrade}/cutover`);
    audit.observeResponse(
      "POST",
      `${upgrade}/cutover`,
      200,
      boundedJsonBody({
        success: true,
        data: { runtime: "dedicated", activeAgentId: "private-target" },
      }).responseBody,
    );
    const adoption = `${upgrade}/adopt-existing`;
    audit.observeRequest("GET", adoption);
    audit.observeResponse(
      "GET",
      adoption,
      200,
      boundedJsonBody({
        success: true,
        data: {
          requiresConfirmation: true,
          action: "adopt_existing_dedicated",
          canAdopt: true,
          quoteId: "private-adoption-quote",
          dedicatedAgentId: "private-adoption-target",
        },
      }).responseBody,
    );
    audit.observeRequest("GET", adoption);
    audit.observeResponse(
      "GET",
      adoption,
      404,
      boundedJsonBody({
        success: false,
        code: "dedicated_adoption_unavailable",
      }).responseBody,
    );
    audit.observeRequest("GET", adoption);
    audit.observeResponse("GET", adoption, 503);
    audit.observeRequest("GET", adoption);
    audit.observeResponse("GET", adoption, 302);
    audit.observeRequest("GET", adoption);
    audit.observeRequestFailure("GET", adoption, "private timeout detail");
    audit.observeRequest("GET", adoption);
    audit.observeRequest("POST", `${upgrade}/adopt-existing`);
    audit.observeRequest("GET", upgrade);
    audit.observeRequestFailure("GET", upgrade, "private timeout detail");
    audit.observeRequest("GET", upgrade);

    const snapshot = await audit.snapshot();
    expect(snapshot).toMatchObject({
      personalIdentityGetRequestCount: 6,
      successfulPersonalIdentityGetCount: 1,
      clientErrorPersonalIdentityGetResponseCount: 1,
      serverErrorPersonalIdentityGetResponseCount: 1,
      otherPersonalIdentityGetResponseCount: 1,
      failedPersonalIdentityGetRequestCount: 1,
      pendingPersonalIdentityGetRequestCount: 1,
      completedPersonalIdentityResponseBodyCount: 1,
      parsedPersonalIdentityResponseBodyCount: 1,
      decodedSharedPersonalIdentityResponseCount: 1,
      decodedDedicatedPersonalIdentityResponseCount: 0,
      uninspectablePersonalIdentityResponseBodyCount: 0,
      dedicatedQuoteGetRequestCount: 3,
      successfulDedicatedQuoteGetResponseCount: 1,
      clientErrorDedicatedQuoteGetResponseCount: 0,
      serverErrorDedicatedQuoteGetResponseCount: 0,
      otherDedicatedQuoteGetResponseCount: 0,
      failedDedicatedQuoteGetRequestCount: 1,
      pendingDedicatedQuoteGetRequestCount: 1,
      completedDedicatedQuoteResponseBodyCount: 1,
      parsedDedicatedQuoteResponseBodyCount: 1,
      decodedDedicatedQuoteResponseCount: 1,
      uninspectableDedicatedQuoteResponseBodyCount: 0,
      dedicatedActivationPostRequestCount: 1,
      successfulDedicatedActivationPostResponseCount: 1,
      clientErrorDedicatedActivationPostResponseCount: 0,
      serverErrorDedicatedActivationPostResponseCount: 0,
      otherDedicatedActivationPostResponseCount: 0,
      failedDedicatedActivationPostRequestCount: 0,
      pendingDedicatedActivationPostRequestCount: 0,
      completedDedicatedActivationResponseBodyCount: 1,
      parsedDedicatedActivationResponseBodyCount: 1,
      decodedDedicatedActivationReceiptCount: 1,
      uninspectableDedicatedActivationResponseBodyCount: 0,
      dedicatedActivationResponseStatus: 202,
      dedicatedActivationResponseCode: null,
      dedicatedCutoverPostRequestCount: 2,
      successfulDedicatedCutoverPostResponseCount: 1,
      clientErrorDedicatedCutoverPostResponseCount: 1,
      serverErrorDedicatedCutoverPostResponseCount: 0,
      otherDedicatedCutoverPostResponseCount: 0,
      failedDedicatedCutoverPostRequestCount: 0,
      pendingDedicatedCutoverPostRequestCount: 0,
      completedDedicatedCutoverResponseBodyCount: 2,
      parsedDedicatedCutoverResponseBodyCount: 2,
      decodedDedicatedCutoverPendingResponseCount: 1,
      decodedDedicatedCutoverFinalResponseCount: 1,
      uninspectableDedicatedCutoverResponseBodyCount: 0,
      dedicatedAdoptionQuoteGetRequestCount: 6,
      successfulDedicatedAdoptionQuoteGetResponseCount: 1,
      clientErrorDedicatedAdoptionQuoteGetResponseCount: 1,
      serverErrorDedicatedAdoptionQuoteGetResponseCount: 1,
      otherDedicatedAdoptionQuoteGetResponseCount: 1,
      failedDedicatedAdoptionQuoteGetRequestCount: 1,
      pendingDedicatedAdoptionQuoteGetRequestCount: 1,
      completedDedicatedAdoptionQuoteResponseBodyCount: 2,
      parsedDedicatedAdoptionQuoteResponseBodyCount: 2,
      decodedAdoptableDedicatedAdoptionQuoteCount: 1,
      decodedUnavailableDedicatedAdoptionQuoteCount: 1,
      uninspectableDedicatedAdoptionQuoteResponseBodyCount: 2,
      dedicatedAdoptionConfirmationPostRequestCount: 1,
      dedicatedApprovalBindingPresent: false,
      dedicatedLifecycleBindingMismatchCount: 4,
    });
    expect(JSON.stringify(snapshot)).not.toMatch(/api\.test|private|timeout/);
  });

  it("retains only the bounded Dedicated activation status and error code", async () => {
    const audit = createCloudLiveNetworkAudit();
    const upgrade =
      "https://api.test/api/v1/eliza/agents/private-target/upgrade-tier";
    audit.observeRequest(
      "POST",
      upgrade,
      JSON.stringify({ quoteId: "private-quote" }),
    );
    audit.observeResponse(
      "POST",
      upgrade,
      409,
      boundedJsonBody({
        success: false,
        code: "dedicated_quote_changed",
        message: "private user detail",
      }).responseBody,
    );

    const snapshot = await audit.snapshot();
    expect(snapshot.dedicatedActivationResponseStatus).toBe(409);
    expect(snapshot.dedicatedActivationResponseCode).toBe(
      "dedicated_quote_changed",
    );
    expect(JSON.stringify(snapshot)).not.toMatch(/private user detail|quoteId/);
  });

  it("fails closed when an approved quote is followed by another agent target", async () => {
    const sourceAgentId = "private-personal";
    const dedicatedAgentId = "private-dedicated";
    const quoteId = "private-quote";
    const sourceBase = `https://api.test/api/v1/eliza/agents/${sourceAgentId}/upgrade-tier`;
    const approved = createCloudLiveNetworkAudit();
    approved.setDedicatedApprovalBinding({
      confirmationKind: "adoption",
      sourceAgentId,
      quoteId,
      dedicatedAgentId,
    });
    approved.observeRequest(
      "POST",
      sourceBase,
      JSON.stringify({
        action: "activate_dedicated",
        quoteId: "selection-quote",
      }),
    );
    approved.observeResponse(
      "POST",
      sourceBase,
      409,
      boundedJsonBody({
        success: false,
        code: "dedicated_adoption_selection_required",
      }).responseBody,
    );
    approved.observeRequest(
      "POST",
      `${sourceBase}/adopt-existing`,
      JSON.stringify({ action: "adopt_existing_dedicated", quoteId }),
    );
    approved.observeRequest(
      "POST",
      `${sourceBase}/cutover`,
      JSON.stringify({ dedicatedAgentId }),
    );
    const approvedSnapshot = await approved.snapshot();
    expect(approvedSnapshot).toMatchObject({
      dedicatedApprovalBindingPresent: true,
      dedicatedLifecycleBindingMismatchCount: 0,
    });

    const ambiguousSelection = createCloudLiveNetworkAudit();
    ambiguousSelection.setDedicatedApprovalBinding({
      confirmationKind: "adoption",
      sourceAgentId,
      quoteId,
      dedicatedAgentId,
    });
    ambiguousSelection.observeRequest(
      "POST",
      sourceBase,
      JSON.stringify({
        action: "activate_dedicated",
        quoteId: "selection-quote",
      }),
    );
    ambiguousSelection.observeResponse(
      "POST",
      sourceBase,
      409,
      boundedJsonBody({ success: false, code: "unknown_client_error" })
        .responseBody,
    );
    expect(await ambiguousSelection.snapshot()).toMatchObject({
      dedicatedApprovalBindingPresent: true,
      dedicatedLifecycleBindingMismatchCount: 1,
    });

    const mismatched = createCloudLiveNetworkAudit();
    mismatched.setDedicatedApprovalBinding({
      confirmationKind: "adoption",
      sourceAgentId,
      quoteId,
      dedicatedAgentId,
    });
    mismatched.observeRequest(
      "POST",
      `${sourceBase}/adopt-existing`,
      JSON.stringify({
        action: "adopt_existing_dedicated",
        quoteId: "different-private-quote",
      }),
    );
    mismatched.observeRequest(
      "POST",
      `${sourceBase}/cutover`,
      JSON.stringify({ dedicatedAgentId: "different-private-target" }),
    );
    const mismatchedSnapshot = await mismatched.snapshot();
    expect(mismatchedSnapshot).toMatchObject({
      dedicatedApprovalBindingPresent: true,
      dedicatedLifecycleBindingMismatchCount: 2,
    });
    expect(JSON.stringify(mismatchedSnapshot)).not.toMatch(
      /private-personal|private-quote|private-target|private-dedicated/,
    );
    expect(() =>
      createCloudLiveContinuityEvidence({
        ...passingInput(),
        dedicatedMutationProof: {
          approvalGrantedCount: 1,
          confirmationClickCount: 1,
          confirmationKind: "adoption",
          adoptionConfirmationPostCount: 1,
          activationPostCount: 0,
          cutoverPostCount: 1,
          forbiddenAgentMutationCount: 1,
          approvalBindingPresent: true,
          lifecycleBindingMismatchCount:
            mismatchedSnapshot.dedicatedLifecycleBindingMismatchCount,
        },
      }),
    ).toThrow("outside the approved target or quote");
  });

  it("binds generic activation and cutover to one decoded quote and target", async () => {
    const sourceAgentId = "private-personal";
    const dedicatedAgentId = "private-dedicated";
    const quoteId = "private-quote";
    const sourceBase = `https://api.test/api/v1/eliza/agents/${sourceAgentId}/upgrade-tier`;
    const audit = createCloudLiveNetworkAudit();
    audit.observeRequest("GET", sourceBase);
    audit.observeResponse(
      "GET",
      sourceBase,
      200,
      boundedJsonBody({
        success: true,
        data: {
          quoteId,
          activation: { state: "available", dedicatedAgentId },
        },
      }).responseBody,
    );
    const binding = await audit.latestDedicatedActivationApprovalBinding();
    expect(binding).toEqual({
      confirmationKind: "activation",
      sourceAgentId,
      quoteId,
      dedicatedAgentId,
    });
    if (!binding) throw new Error("activation binding missing");
    audit.setDedicatedApprovalBinding(binding);
    audit.observeRequest(
      "POST",
      sourceBase,
      JSON.stringify({ action: "activate_dedicated", quoteId }),
    );
    audit.observeResponse(
      "POST",
      sourceBase,
      200,
      boundedJsonBody({ success: true, data: { dedicatedAgentId } })
        .responseBody,
    );
    audit.observeRequest(
      "POST",
      `${sourceBase}/cutover`,
      JSON.stringify({ dedicatedAgentId }),
    );
    expect(await audit.snapshot()).toMatchObject({
      dedicatedApprovalBindingPresent: true,
      dedicatedLifecycleBindingMismatchCount: 0,
    });

    const missingProvenance = createCloudLiveNetworkAudit();
    missingProvenance.setDedicatedApprovalBinding(binding);
    missingProvenance.observeRequest("POST", `${sourceBase}/cutover`, "{}");
    expect(await missingProvenance.snapshot()).toMatchObject({
      dedicatedApprovalBindingPresent: true,
      dedicatedLifecycleBindingMismatchCount: 1,
    });
  });

  it("distinguishes Personal response headers, body, parse, and runtime decode", async () => {
    vi.useFakeTimers();
    const audit = createCloudLiveNetworkAudit();
    const personal = "https://api.test/api/v1/eliza/personal";
    const shared = boundedJsonBody({
      success: true,
      data: { identity: { runtime: "shared", id: "private-shared" } },
    });
    const dedicated = boundedJsonBody({
      success: true,
      data: {
        identity: { runtime: "dedicated", id: "private-dedicated" },
      },
    });
    const malformed = boundedJsonBody(null, { raw: "not-json" });
    const stalled = {
      contentType: "application/json",
      async read() {
        return await new Promise<Uint8Array | null>(() => undefined);
      },
    };

    for (const responseBody of [
      shared.responseBody,
      dedicated.responseBody,
      malformed.responseBody,
      stalled,
    ]) {
      audit.observeRequest("GET", personal);
      audit.observeResponse("GET", personal, 200, responseBody);
    }
    const snapshotPromise = audit.snapshot();
    await vi.advanceTimersByTimeAsync(30_000);
    const snapshot = await snapshotPromise;

    expect(snapshot).toMatchObject({
      personalIdentityGetRequestCount: 4,
      successfulPersonalIdentityGetCount: 4,
      completedPersonalIdentityResponseBodyCount: 3,
      parsedPersonalIdentityResponseBodyCount: 2,
      decodedSharedPersonalIdentityResponseCount: 1,
      decodedDedicatedPersonalIdentityResponseCount: 1,
      uninspectablePersonalIdentityResponseBodyCount: 1,
    });
    expect(JSON.stringify(snapshot)).not.toMatch(/private|api\.test|not-json/);
  });

  it("reduces timed-out history proof traffic to privacy-safe counters", async () => {
    const audit = createCloudLiveNetworkAudit();
    const privateHistory =
      "https://api.test/api/conversations/private-conversation/messages";
    const before = await audit.snapshot();

    for (const status of [200, 404, 503, 302]) {
      audit.observeRequest("GET", privateHistory);
      audit.observeResponse("GET", privateHistory, status);
    }
    audit.observeRequest("GET", privateHistory);
    audit.observeRequestFailure(
      "GET",
      privateHistory,
      "net::ERR_TIMED_OUT private-token",
    );
    audit.observeRequest("GET", privateHistory);
    audit.observeRequestFailure("GET", privateHistory, "net::ERR_FAILED");
    audit.observeRequest("GET", privateHistory);
    audit.observeRequest("POST", privateHistory);
    audit.observeRequestFailure(
      "GET",
      "https://api.test/api/not-history/private-conversation",
      "net::ERR_TIMED_OUT",
    );

    const diagnostics = createCloudLiveHistoryNetworkDiagnostics(
      "post-reload",
      before,
      await audit.snapshot(),
    );
    expect(diagnostics).toEqual({
      schemaVersion: 1,
      phase: "post-reload",
      proofTimeoutCount: 1,
      historyGetRequestCount: 7,
      successfulHistoryGetResponseCount: 1,
      clientErrorHistoryGetResponseCount: 1,
      serverErrorHistoryGetResponseCount: 1,
      otherHistoryGetResponseCount: 1,
      failedHistoryGetRequestCount: 2,
      timedOutHistoryGetRequestCount: 1,
      pendingHistoryGetRequestCount: 1,
      inspectedHistoryResponseCount: 0,
      uninspectableHistoryResponseCount: 0,
      historyResponseWithAnchorUserCount: 0,
      historyResponseWithAnchoredAssistantCount: 0,
    });
    expect(JSON.stringify(diagnostics)).not.toMatch(
      /api\.test|private|token|ERR_|conversation/,
    );
  });

  it("rejects history diagnostics assembled from unrelated audit snapshots", async () => {
    const beforeAudit = createCloudLiveNetworkAudit();
    beforeAudit.observeRequest("GET", "/api/conversations/private/messages");
    const afterAudit = createCloudLiveNetworkAudit();
    const before = await beforeAudit.snapshot();
    const after = await afterAudit.snapshot();
    expect(() =>
      createCloudLiveHistoryNetworkDiagnostics("fresh-context", before, after),
    ).toThrow("must not precede its baseline");
  });

  it("reports pending history requests when an older request completes after the baseline", async () => {
    const audit = createCloudLiveNetworkAudit();
    const privateHistory =
      "https://api.test/api/conversations/private-conversation/messages";
    audit.observeRequest("GET", privateHistory);
    const before = await audit.snapshot();

    audit.observeResponse("GET", privateHistory, 200);
    audit.observeRequest("GET", privateHistory);

    const diagnostics = createCloudLiveHistoryNetworkDiagnostics(
      "fresh-context",
      before,
      await audit.snapshot(),
    );
    expect(diagnostics).toMatchObject({
      historyGetRequestCount: 1,
      successfulHistoryGetResponseCount: 1,
      pendingHistoryGetRequestCount: 1,
    });
  });

  it("classifies an anchored history pair without retaining private body content", async () => {
    const audit = createCloudLiveNetworkAudit();
    const history =
      "https://api.test/api/conversations/private-conversation/messages";
    const anchor = "private-anchor-token";
    audit.setHistoryAnchorToken(anchor);
    const before = await audit.snapshot();
    const body = boundedJsonBody({
      messages: [
        { role: "assistant", text: "old private answer" },
        { role: "user", text: `private prompt ${anchor}` },
        { role: "assistant", text: "new private answer" },
      ],
    });

    audit.observeRequest("GET", history);
    audit.observeResponse("GET", history, 200, body.responseBody);
    const diagnostics = createCloudLiveHistoryNetworkDiagnostics(
      "post-reload",
      before,
      await audit.snapshot(),
    );

    expect(diagnostics).toMatchObject({
      successfulHistoryGetResponseCount: 1,
      inspectedHistoryResponseCount: 1,
      uninspectableHistoryResponseCount: 0,
      historyResponseWithAnchorUserCount: 1,
      historyResponseWithAnchoredAssistantCount: 1,
    });
    expect(body.budgets).toEqual([1024 * 1024]);
    expect(JSON.stringify(diagnostics)).not.toMatch(
      /private|anchor|prompt|answer|api\.test|conversation/,
    );
  });

  it("does not pair an anchor with an assistant after a newer user turn", async () => {
    const audit = createCloudLiveNetworkAudit();
    const history = "/api/conversations/private/messages";
    audit.setHistoryAnchorToken("private-anchor");
    audit.observeRequest("GET", history);
    audit.observeResponse(
      "GET",
      history,
      200,
      boundedJsonBody({
        messages: [
          { role: "user", text: "private-anchor" },
          { role: "user", text: "newer private turn" },
          { role: "assistant", text: "belongs to newer turn" },
        ],
      }).responseBody,
    );

    expect(await audit.snapshot()).toMatchObject({
      inspectedHistoryResponseCount: 1,
      historyResponseWithAnchorUserCount: 1,
      historyResponseWithAnchoredAssistantCount: 0,
    });
  });

  it("does not report an anchored assistant when the user anchor is absent", async () => {
    const audit = createCloudLiveNetworkAudit();
    const history = "/api/conversations/private/messages";
    audit.setHistoryAnchorToken("missing-private-anchor");
    audit.observeRequest("GET", history);
    audit.observeResponse(
      "GET",
      history,
      200,
      boundedJsonBody({
        messages: [{ role: "assistant", text: "unrelated older assistant" }],
      }).responseBody,
    );

    expect(await audit.snapshot()).toMatchObject({
      inspectedHistoryResponseCount: 1,
      historyResponseWithAnchorUserCount: 0,
      historyResponseWithAnchoredAssistantCount: 0,
    });
  });

  it("reports unreadable or oversized history bodies as uninspectable", async () => {
    const audit = createCloudLiveNetworkAudit();
    const history = "/api/conversations/private/messages";
    audit.setHistoryAnchorToken("private-anchor");
    for (const body of [
      boundedJsonBody({}, { contentType: "text/plain" }).responseBody,
      boundedJsonBody({}, { reject: true }).responseBody,
      boundedJsonBody({}, { raw: "{", ignoreBudget: true }).responseBody,
    ]) {
      audit.observeRequest("GET", history);
      audit.observeResponse("GET", history, 200, body);
    }

    expect(await audit.snapshot()).toMatchObject({
      successfulHistoryGetCount: 3,
      inspectedHistoryResponseCount: 0,
      uninspectableHistoryResponseCount: 3,
      historyResponseWithAnchorUserCount: 0,
      historyResponseWithAnchoredAssistantCount: 0,
    });
  });

  it("counts only the two named warming codes and drains body handlers", async () => {
    const audit = createCloudLiveNetworkAudit();
    const chat =
      "https://api.test/api/v1/eliza/agents/private/api/conversations/private/messages/stream";
    const postData = JSON.stringify({
      text: "private prompt",
      clientMessageId: "private-idempotency-key",
    });
    const first = boundedJsonBody({ code: "agent_cache_warming" });
    const second = boundedJsonBody({ code: "shared_runtime_cache_warming" });
    let releaseBody!: () => void;
    const bodyGate = new Promise<void>((resolve) => {
      releaseBody = resolve;
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      audit.observeRequest("POST", chat, postData);
    }
    audit.observeResponse("POST", chat, 503, {
      ...first.responseBody,
      async read(maxBytes) {
        await bodyGate;
        return first.responseBody.read(maxBytes);
      },
    });
    audit.observeResponse("POST", chat, 503, second.responseBody);
    audit.observeResponse("POST", chat, 200);

    let snapshotSettled = false;
    const pendingSnapshot = audit.snapshot().then((snapshot) => {
      snapshotSettled = true;
      return snapshot;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(snapshotSettled).toBe(false);
    releaseBody();

    const snapshot = await pendingSnapshot;
    expect(snapshot).toMatchObject({
      chatSendAttemptCount: 3,
      logicalChatSendCount: 1,
      unidentifiedChatSendAttemptCount: 0,
      namedWarmingResponseCount: 2,
      successfulChatSendResponseCount: 1,
      serverErrorChatSendResponseCount: 2,
    });
    expect([...first.budgets, ...second.budgets]).toEqual([4096, 4096]);
    expect(JSON.stringify(snapshot)).not.toMatch(
      /agent_cache_warming|shared_runtime_cache_warming|private|idempotency/,
    );
  });

  it("rejects non-allowlisted, unreadable, non-JSON, and oversized bodies", async () => {
    const audit = createCloudLiveNetworkAudit();
    const chat = "/api/conversations/private/messages/stream";
    const otherCode = boundedJsonBody({ code: "inference_unavailable" });
    const falsePrefix = boundedJsonBody({ code: "agent_cache_warming_extra" });
    const malformed = boundedJsonBody(null, { raw: "{" });
    const nonObject = boundedJsonBody(["agent_cache_warming"]);
    const wrongMedia = boundedJsonBody(
      { code: "agent_cache_warming" },
      {
        contentType: "text/plain",
      },
    );
    const overBudget = boundedJsonBody({
      code: "agent_cache_warming",
      padding: "x".repeat(5_000),
    });
    const lyingReader = boundedJsonBody(
      { code: "agent_cache_warming", padding: "x".repeat(5_000) },
      { ignoreBudget: true },
    );
    const rejected = boundedJsonBody(
      { code: "agent_cache_warming" },
      {
        reject: true,
      },
    );
    let wrongRouteRead = false;

    for (const body of [
      otherCode,
      falsePrefix,
      malformed,
      nonObject,
      wrongMedia,
      overBudget,
      lyingReader,
      rejected,
    ]) {
      audit.observeResponse("POST", chat, 503, body.responseBody);
    }
    audit.observeResponse(
      "POST",
      chat,
      502,
      boundedJsonBody({
        code: "agent_cache_warming",
      }).responseBody,
    );
    audit.observeResponse("POST", "/api/not-chat", 503, {
      contentType: "application/json",
      async read() {
        wrongRouteRead = true;
        return textEncoder.encode('{"code":"agent_cache_warming"}');
      },
    });

    const snapshot = await audit.snapshot();
    expect(snapshot.namedWarmingResponseCount).toBe(0);
    expect(wrongRouteRead).toBe(false);
    expect(wrongMedia.budgets).toEqual([]);
    expect(overBudget.budgets).toEqual([4096]);
    expect(lyingReader.budgets).toEqual([4096]);
  });
});

describe("bounded Cloud response diagnostics", () => {
  it("treats a zero-byte body as unavailable rather than inspected proof", async () => {
    const read = vi.fn(async () => new Uint8Array());

    await expect(
      readCloudLiveBoundedResponseBody(
        { contentType: "application/json", read },
        1024,
      ),
    ).resolves.toBeNull();
    expect(read).toHaveBeenCalledWith(1024);
  });

  it("settles an indefinitely pending body before the trajectory phase deadline", async () => {
    vi.useFakeTimers();
    const pending = readCloudLiveBoundedResponseBody(
      {
        contentType: "application/json",
        read: () => new Promise<Uint8Array | null>(() => {}),
      },
      1024,
      30_000,
    );

    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBeNull();
  });

  it("drains stalled history and warming inspections without creating proof", async () => {
    vi.useFakeTimers();
    const audit = createCloudLiveNetworkAudit();
    const history = "/api/conversations/private/messages";
    const chat = `${history}/stream`;
    const neverSettles = {
      contentType: "application/json",
      read: () => new Promise<Uint8Array | null>(() => {}),
    };
    audit.setHistoryAnchorToken("private-anchor");
    audit.observeRequest("GET", history);
    audit.observeResponse("GET", history, 200, neverSettles);
    audit.observeRequest(
      "POST",
      chat,
      JSON.stringify({ clientMessageId: "private-id" }),
    );
    audit.observeResponse("POST", chat, 503, neverSettles);

    let settled = false;
    const pending = audit.snapshot().then((snapshot) => {
      settled = true;
      return snapshot;
    });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toMatchObject({
      successfulHistoryGetCount: 1,
      inspectedHistoryResponseCount: 0,
      uninspectableHistoryResponseCount: 1,
      historyResponseWithAnchorUserCount: 0,
      historyResponseWithAnchoredAssistantCount: 0,
      namedWarmingResponseCount: 0,
    });
  });

  it("rejects invalid byte and time budgets without reading the body", async () => {
    const read = vi.fn(async () => textEncoder.encode("{}"));
    const body = { contentType: "application/json", read };

    await expect(readCloudLiveBoundedResponseBody(body, 0)).rejects.toThrow(
      "byte budget must be a positive safe integer",
    );
    await expect(
      readCloudLiveBoundedResponseBody(body, 1024, 0),
    ).rejects.toThrow("timeout must be a positive safe integer");
    expect(read).not.toHaveBeenCalled();
  });
});

describe("named warming browser proof", () => {
  it("records a transient Retry chip only on the anchored turn owner", () => {
    const { document } = new JSDOM("<!doctype html><body></body>").window;
    const row = (role: "user" | "assistant", text = "") => {
      const element = document.createElement("div");
      element.dataset.testid = "thread-line";
      element.dataset.role = role;
      element.textContent = text;
      return element;
    };
    const wrap = (element: HTMLElement) => {
      const wrapper = document.createElement("div");
      wrapper.dataset.slot = "message-scroller-item";
      wrapper.append(element);
      return wrapper;
    };
    const unrelatedAssistant = row("assistant");
    const anchoredUser = row("user", "prompt with anchor-123");
    document.body.replaceChildren(wrap(unrelatedAssistant), wrap(anchoredUser));
    const retryChip = () => {
      const element = document.createElement("button");
      element.dataset.testid = "thread-line-retry";
      return element;
    };

    const unrelated = installCloudLiveAnchoredRetryChipObserver(
      "anchor-123",
      document,
    );
    const unrelatedChip = retryChip();
    unrelatedAssistant.append(unrelatedChip);
    unrelatedChip.remove();
    expect(unrelated.stop()).toBe(false);

    const anchored = installCloudLiveAnchoredRetryChipObserver(
      "anchor-123",
      document,
    );
    const transientOwner = row("assistant");
    const transientChip = retryChip();
    transientOwner.append(transientChip);
    const transientWrapper = wrap(transientOwner);
    document.body.append(transientWrapper);
    transientChip.remove();
    transientWrapper.remove();
    expect(anchored.stop()).toBe(true);
  });

  it("is dormant by default and requires deployed staging when enabled", () => {
    expect(() =>
      assertCloudLiveNamedWarmingMode({
        required: false,
        deployedRenderer: false,
        cloudEnvironment: "production",
      }),
    ).not.toThrow();
    expect(() =>
      assertCloudLiveNamedWarmingMode({
        required: true,
        deployedRenderer: true,
        cloudEnvironment: "staging",
      }),
    ).not.toThrow();
    expect(() =>
      assertCloudLiveNamedWarmingMode({
        required: true,
        deployedRenderer: false,
        cloudEnvironment: "staging",
      }),
    ).toThrow("requires a deployed renderer");
    expect(() =>
      assertCloudLiveNamedWarmingMode({
        required: true,
        deployedRenderer: true,
        cloudEnvironment: "production",
      }),
    ).toThrow("requires the staging Cloud environment");
  });

  it("accepts only a retried, identified, named, invisible terminal turn", () => {
    const passing = {
      required: true,
      terminalLivenessPassed: true,
      chatSendAttemptCount: 3,
      logicalChatSendCount: 1,
      unidentifiedChatSendAttemptCount: 0,
      namedWarmingResponseCount: 2,
      retryChipEverObserved: false,
    } as const;
    expect(() => assertCloudLiveNamedWarmingProof(passing)).not.toThrow();
    expect(() =>
      assertCloudLiveNamedWarmingProof({
        ...passing,
        required: false,
        terminalLivenessPassed: false,
        chatSendAttemptCount: 0,
      }),
    ).not.toThrow();

    for (const [override, message] of [
      [{ terminalLivenessPassed: false }, "terminalLivenessPassed"],
      [{ chatSendAttemptCount: 1 }, "chatSendAttemptCount"],
      [{ logicalChatSendCount: 2 }, "logicalChatSendCount"],
      [
        { unidentifiedChatSendAttemptCount: 1 },
        "unidentifiedChatSendAttemptCount",
      ],
      [{ namedWarmingResponseCount: 0 }, "namedWarmingResponseCount"],
      [{ retryChipEverObserved: true }, "retryChipEverObserved"],
    ] as const) {
      expect(() =>
        assertCloudLiveNamedWarmingProof({ ...passing, ...override }),
      ).toThrow(message);
    }
  });
});

describe("privacy-safe continuity evidence", () => {
  it("reduces private bindings to booleans", () => {
    const reference = {
      personalIdentity: "private-personal",
      runtimeBinding: "private-runtime",
      runtime: "shared" as const,
      apiBase: "https://api.example.test/runtime/",
    };
    const comparison = compareCloudLiveRuntimeBindings(reference, {
      ...reference,
      apiBase: "https://api.example.test/runtime",
    });
    expect(comparison).toEqual({
      personalIdentityReused: true,
      runtimeBindingReused: true,
      apiBaseReused: true,
    });
    expect(JSON.stringify(comparison)).not.toMatch(/private|example\.test/);
  });

  it("emits the flat closed proof and honest cleanup semantics", () => {
    expect(createCloudLiveContinuityEvidence(passingInput())).toEqual({
      schemaVersion: 2,
      lane: "app-live-e2e-cloud-staging",
      challengeTurnCount: 1,
      noAdditionalChatSendAfterChallenge: true,
      personalIdentityEndpointPassed: true,
      reloadHistoryPassed: true,
      freshContextHistoryPassed: true,
      personalIdentityReused: true,
      runtimeBindingReused: true,
      apiBaseReused: true,
      dedicatedApprovalDisposition: "not-approved",
      dedicatedApprovalGrantedCount: 0,
      dedicatedConfirmationKind: "none",
      dedicatedConfirmationClickCount: 0,
      dedicatedAdoptionConfirmationPostCount: 0,
      dedicatedActivationPostCount: 0,
      dedicatedCutoverPostCount: 0,
      forbiddenAgentMutationCount: 0,
      otherForbiddenAgentMutationCount: 0,
      dedicatedApprovalBindingPresent: false,
      dedicatedLifecycleBindingMismatchCount: 0,
      cleanupDisposition: "no-test-owned-agent",
      conversationHistoryDisposition: "preserved",
    });
  });

  it("fails closed on a second challenge, incomplete proof, or mutation", () => {
    expect(() =>
      createCloudLiveContinuityEvidence({
        ...passingInput(),
        challengeTurnCount: 2,
      }),
    ).toThrow("must be one");
    expect(() =>
      createCloudLiveContinuityEvidence({
        ...passingInput(),
        reload: { ...passingInput().reload, challengeUserLinePresent: false },
      }),
    ).toThrow("reload.challengeUserLinePresent must be true");
    expect(() =>
      createCloudLiveContinuityEvidence({
        ...passingInput(),
        personalIdentityEndpointPassed: false,
      }),
    ).toThrow("personalIdentityEndpointPassed must be true");
    expect(() =>
      createCloudLiveContinuityEvidence({
        ...passingInput(),
        dedicatedMutationProof: {
          ...passingInput().dedicatedMutationProof,
          forbiddenAgentMutationCount: 1,
        },
      }),
    ).toThrow("unauthorized agent lifecycle mutation");
  });

  it("allows only the exact explicitly approved Dedicated lifecycle", () => {
    const adoption = createCloudLiveContinuityEvidence({
      ...passingInput(),
      dedicatedMutationProof: {
        approvalGrantedCount: 1,
        confirmationClickCount: 1,
        confirmationKind: "adoption",
        adoptionConfirmationPostCount: 1,
        activationPostCount: 1,
        cutoverPostCount: 2,
        forbiddenAgentMutationCount: 3,
        approvalBindingPresent: true,
        lifecycleBindingMismatchCount: 0,
      },
    });
    expect(adoption).toMatchObject({
      dedicatedApprovalDisposition: "approved-ui-confirmation",
      dedicatedConfirmationKind: "adoption",
      dedicatedAdoptionConfirmationPostCount: 1,
      dedicatedActivationPostCount: 1,
      dedicatedCutoverPostCount: 2,
      forbiddenAgentMutationCount: 3,
      otherForbiddenAgentMutationCount: 0,
    });
    expect(parseCloudLiveContinuityEvidence(adoption)).toEqual(adoption);
    expect(() =>
      parseCloudLiveContinuityEvidence({
        ...adoption,
        otherForbiddenAgentMutationCount: 1,
      }),
    ).toThrow("artifact.otherForbiddenAgentMutationCount is invalid");

    const activation = createCloudLiveContinuityEvidence({
      ...passingInput(),
      dedicatedMutationProof: {
        approvalGrantedCount: 1,
        confirmationClickCount: 1,
        confirmationKind: "activation",
        adoptionConfirmationPostCount: 0,
        activationPostCount: 1,
        cutoverPostCount: 1,
        forbiddenAgentMutationCount: 2,
        approvalBindingPresent: true,
        lifecycleBindingMismatchCount: 0,
      },
    });
    expect(activation).toMatchObject({
      dedicatedApprovalDisposition: "approved-ui-confirmation",
      dedicatedConfirmationKind: "activation",
      dedicatedActivationPostCount: 1,
      dedicatedCutoverPostCount: 1,
      otherForbiddenAgentMutationCount: 0,
    });

    const approvalUnused = createCloudLiveContinuityEvidence({
      ...passingInput(),
      dedicatedMutationProof: {
        ...passingInput().dedicatedMutationProof,
        approvalGrantedCount: 1,
      },
    });
    expect(approvalUnused.dedicatedApprovalDisposition).toBe("approval-unused");

    for (const dedicatedMutationProof of [
      {
        ...passingInput().dedicatedMutationProof,
        approvalGrantedCount: 1 as const,
        confirmationClickCount: 1,
        confirmationKind: "adoption" as const,
        adoptionConfirmationPostCount: 1,
        cutoverPostCount: 1,
        forbiddenAgentMutationCount: 2,
        approvalBindingPresent: true,
        lifecycleBindingMismatchCount: 0,
      },
      {
        approvalGrantedCount: 0 as const,
        confirmationClickCount: 1,
        confirmationKind: "activation" as const,
        adoptionConfirmationPostCount: 0,
        activationPostCount: 1,
        cutoverPostCount: 1,
        forbiddenAgentMutationCount: 2,
        approvalBindingPresent: true,
        lifecycleBindingMismatchCount: 0,
      },
      {
        approvalGrantedCount: 1 as const,
        confirmationClickCount: 1,
        confirmationKind: "adoption" as const,
        adoptionConfirmationPostCount: 2,
        activationPostCount: 0,
        cutoverPostCount: 1,
        forbiddenAgentMutationCount: 1,
        approvalBindingPresent: true,
        lifecycleBindingMismatchCount: 0,
      },
      {
        approvalGrantedCount: 1 as const,
        confirmationClickCount: 1,
        confirmationKind: "activation" as const,
        adoptionConfirmationPostCount: 0,
        activationPostCount: 1,
        cutoverPostCount: 0,
        forbiddenAgentMutationCount: 1,
        approvalBindingPresent: true,
        lifecycleBindingMismatchCount: 0,
      },
      {
        approvalGrantedCount: 1 as const,
        confirmationClickCount: 1,
        confirmationKind: "activation" as const,
        adoptionConfirmationPostCount: 0,
        activationPostCount: 1,
        cutoverPostCount: 1,
        forbiddenAgentMutationCount: 2,
        approvalBindingPresent: false,
        lifecycleBindingMismatchCount: 0,
      },
    ]) {
      expect(() =>
        createCloudLiveContinuityEvidence({
          ...passingInput(),
          dedicatedMutationProof,
        }),
      ).toThrow();
    }
  });

  it("rejects any extra or non-passing JSON field", () => {
    const valid = createCloudLiveContinuityEvidence(passingInput());
    expect(() =>
      parseCloudLiveContinuityEvidence({ ...valid, runtimeId: "private" }),
    ).toThrow("exact closed schema");
    expect(() =>
      parseCloudLiveContinuityEvidence({
        ...valid,
        freshContextHistoryPassed: false,
      }),
    ).toThrow("freshContextHistoryPassed is invalid");
  });

  it("writes mode 0600, refuses overwrite, and persists no private value", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cloud-continuity-"));
    temporaryDirectories.push(directory);
    const outputPath = join(directory, "nested", "continuity.json");
    await writeCloudLiveContinuityEvidence(outputPath, passingInput());
    expect(await readCloudLiveContinuityEvidence(outputPath)).toEqual(
      createCloudLiveContinuityEvidence(passingInput()),
    );
    expect((await stat(outputPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(outputPath, "utf8")).not.toMatch(
      /private|prompt|reply|token|runtimeId|agentId/,
    );
    await expect(
      writeCloudLiveContinuityEvidence(outputPath, passingInput()),
    ).rejects.toThrow();
  });
});
