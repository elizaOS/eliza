/**
 * Unit coverage for the #10726 voice self-test honesty gates:
 *
 *  - `classifyErrorFallbackReply` pins every canonical server fallback string
 *    (chat-routes.ts / recentMessages.ts) so drift is caught here.
 *  - The SEND stage fails on a structured `failureKind`, fails on a
 *    recognized error-fallback reply text, and records which backend served
 *    the run — the exact holes that used to report `send: pass` when the
 *    provider 500'd.
 *
 * The ElizaClient here is a boundary double for the SSE transport only; the
 * harness logic under test is the real production function, and the full
 * transport path is exercised by the web/android/desktop self-test e2e lanes
 * that call this same harness in-app.
 */

import { describe, expect, it } from "vitest";
import type { ElizaClient } from "../../api/client-base";
import {
  classifyErrorFallbackReply,
  type ErrorFallbackReplyKind,
} from "./error-fallback-reply";
import { runVoiceSelfTest } from "./voice-selftest-harness";

describe("classifyErrorFallbackReply", () => {
  const cases: Array<[string, ErrorFallbackReplyKind]> = [
    ["Sorry, I'm having a provider issue", "provider_issue"],
    ["Sorry, I’m having a provider issue", "provider_issue"],
    ["I don't have a reply for that — try rephrasing?", "no_response"],
    ["I don't have a reply for that - try rephrasing?", "no_response"],
    [
      "Eliza Cloud credits are depleted. Top up the cloud balance and try again.",
      "insufficient_credits",
    ],
    [
      "I'm being rate-limited right now — give it a few seconds and try again.",
      "rate_limited",
    ],
    [
      "Connect an LLM provider to start chatting. Open Settings → Providers, " +
        "or choose Eliza Cloud during first-run setup.",
      "no_provider",
    ],
    ["something went wrong on my end. please try again.", "transient_failure"],
    ["Something went wrong on my end. Please try again.", "transient_failure"],
    // Pattern nets (mirror the server's regex fallbacks).
    ["there is a provider issue right now", "provider_issue"],
    ["Something went wrong on my end, sorry!", "transient_failure"],
  ];

  it.each(cases)("classifies %j", (text, kind) => {
    expect(classifyErrorFallbackReply(text)).toBe(kind);
  });

  it("returns null for genuine replies and empty input", () => {
    expect(classifyErrorFallbackReply("The capital of France is Paris.")).toBe(
      null,
    );
    expect(
      classifyErrorFallbackReply("Sure — provider configuration looks fine."),
    ).toBe(null);
    expect(classifyErrorFallbackReply("")).toBe(null);
    expect(classifyErrorFallbackReply("   ")).toBe(null);
    expect(classifyErrorFallbackReply(null)).toBe(null);
    expect(classifyErrorFallbackReply(undefined)).toBe(null);
  });
});

type SendResult = Awaited<
  ReturnType<ElizaClient["sendConversationMessageStream"]>
>;

function clientReturning(send: Partial<SendResult>): ElizaClient {
  return {
    createConversation: async () => ({
      conversation: { id: "conv-selftest-1" },
    }),
    sendConversationMessageStream: async () => ({
      text: "",
      agentName: "Eliza",
      completed: true,
      ...send,
    }),
  } as unknown as ElizaClient;
}

async function runSendStage(send: Partial<SendResult>) {
  const report = await runVoiceSelfTest({
    platform: "web",
    mode: "inject-transcript",
    injectedTranscript: "hello eliza how are you",
    fixtureUrl: "unused-in-inject-mode",
    expectedPhrase: "hello eliza how are you",
    ttsRoute: "/api/tts/local-inference",
    client: clientReturning(send),
    // TTS is exercised only when a reply exists; in this unit environment the
    // route is unreachable so the TTS stage fails/skips — SEND assertions are
    // what this suite pins.
    audioCtx: {} as AudioContext,
  });
  const sendStage = report.stages.find((stage) => stage.stage === "send");
  if (!sendStage) throw new Error("send stage missing from report");
  return { report, sendStage };
}

describe("runVoiceSelfTest SEND honesty (#10726)", () => {
  it("fails on a structured failureKind even when text streamed", async () => {
    const { report, sendStage } = await runSendStage({
      text: "Sorry, I'm having a provider issue",
      completed: true,
      failureKind: "provider_issue",
    });
    expect(sendStage.status).toBe("fail");
    expect(sendStage.error).toContain("failureKind: provider_issue");
    expect(sendStage.detail.failureKind).toBe("provider_issue");
    expect(sendStage.detail.backend).toBe("remote-provider");
    expect(report.overall).toBe("fail");
  });

  it("fails on a recognized error-fallback reply without a failureKind", async () => {
    const { sendStage } = await runSendStage({
      text: "Something went wrong on my end. Please try again.",
      completed: true,
    });
    expect(sendStage.status).toBe("fail");
    expect(sendStage.error).toContain("error-fallback text");
    expect(sendStage.detail.fallbackReplyKind).toBe("transient_failure");
  });

  it("fails a local_inference failureKind and records the local backend", async () => {
    const { sendStage } = await runSendStage({
      text: "Sorry, I'm having a provider issue",
      completed: true,
      failureKind: "local_inference",
      localInference: { status: "failed", modelId: "eliza-1-2b" },
    });
    expect(sendStage.status).toBe("fail");
    expect(sendStage.detail.backend).toBe("local-inference:eliza-1-2b");
    expect(sendStage.detail.failureKind).toBe("local_inference");
  });

  it("passes a genuine reply and records the serving backend", async () => {
    const { report, sendStage } = await runSendStage({
      text: "Doing great — how can I help?",
      completed: true,
      localInference: {
        status: "ready",
        activeModelId: "eliza-1-4b",
        provider: "local",
      },
    });
    expect(sendStage.status).toBe("pass");
    expect(sendStage.detail.backend).toBe("local-inference:eliza-1-4b");
    expect(report.sendBackend).toBe("local-inference:eliza-1-4b");
    expect(report.reply).toBe("Doing great — how can I help?");
  });

  it("still fails an empty / incomplete reply", async () => {
    const { sendStage } = await runSendStage({ text: "", completed: false });
    expect(sendStage.status).toBe("fail");
    expect(sendStage.error).toContain("no reply");
  });
});
