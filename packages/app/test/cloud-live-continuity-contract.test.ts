/** Unit coverage for the privacy-safe Cloud history-continuity contract. */

import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertCloudLiveNamedWarmingMode,
  assertCloudLiveNamedWarmingProof,
  type CloudLiveContinuityEvidenceInput,
  classifyForbiddenAgentMutation,
  compareCloudLiveRuntimeBindings,
  createCloudLiveContinuityEvidence,
  createCloudLiveNetworkAudit,
  installCloudLiveAnchoredRetryChipObserver,
  parseCloudLiveContinuityEvidence,
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
    forbiddenAgentMutationCount: 0,
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
      successfulPersonalIdentityGetCount: 1,
      successfulHistoryGetCount: 1,
    });
    expect(JSON.stringify(snapshot)).not.toMatch(
      /api\.test|private|idempotency|prompt/,
    );
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
      schemaVersion: 1,
      lane: "app-live-e2e-cloud-staging",
      challengeTurnCount: 1,
      noAdditionalChatSendAfterChallenge: true,
      personalIdentityEndpointPassed: true,
      reloadHistoryPassed: true,
      freshContextHistoryPassed: true,
      personalIdentityReused: true,
      runtimeBindingReused: true,
      apiBaseReused: true,
      forbiddenAgentMutationCount: 0,
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
        forbiddenAgentMutationCount: 1,
      }),
    ).toThrow("must be zero");
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
