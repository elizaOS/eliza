/**
 * Pass/fail contract for the e2e chat scripts' bridge-reply classifier
 * (#15616): a genuine token echo passes; every fabrication shape the bridge
 * and runtime can produce — fallback:true, failureKind-tagged canned text,
 * bare canned strings, degraded shared turns, cloud-agent echoes, empty —
 * fails. Pure classifier, no network.
 */
import { describe, expect, test } from "bun:test";
import {
  classifyBridgeReply,
  KNOWN_CANNED_FAILURE_REPLIES,
} from "./bridge-reply-verdict";

const TOKEN = "nightly proof phrase";

describe("classifyBridgeReply", () => {
  test("genuine reply echoing the token passes and reports its transport", () => {
    const verdict = classifyBridgeReply(
      {
        text: `Sure — here is the token ${TOKEN} as requested.`,
        agentName: "Smoke",
        transport: "conversation-rest",
      },
      TOKEN,
    );
    expect(verdict.ok).toBe(true);
    expect(verdict.reason).toBeNull();
    expect(verdict.transport).toBe("conversation-rest");
  });

  test("pre-#15616 bridges without a transport tag report unknown", () => {
    const verdict = classifyBridgeReply(
      { text: `token ${TOKEN} echoed` },
      TOKEN,
    );
    expect(verdict.ok).toBe(true);
    expect(verdict.transport).toBe("unknown");
  });

  test("fallback:true fabrication fails even when the text looks plausible", () => {
    const verdict = classifyBridgeReply(
      {
        text: `pong ${TOKEN}`,
        fallback: true,
        reason: "agent_no_reply",
      },
      TOKEN,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("fabricated fallback");
    expect(verdict.reason).toContain("agent_no_reply");
  });

  test("failureKind-tagged reply fails even if the token were present", () => {
    const verdict = classifyBridgeReply(
      {
        text: `Sorry, I'm having a provider issue with ${TOKEN}`,
        failureKind: "provider_issue",
        transport: "conversation-rest",
      },
      TOKEN,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("failureKind: provider_issue");
    expect(verdict.transport).toBe("conversation-rest");
  });

  test("every known canned failure string fails without needing a flag", () => {
    for (const canned of KNOWN_CANNED_FAILURE_REPLIES) {
      const verdict = classifyBridgeReply({ text: canned }, TOKEN);
      expect(verdict.ok).toBe(false);
    }
  });

  test("smart-quote and whitespace drift cannot dodge the canned-string match", () => {
    const verdict = classifyBridgeReply(
      { text: "  Sorry,  I’m having a provider issue " },
      TOKEN,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("canned failure string");
  });

  test("degraded shared-runtime turn fails", () => {
    const verdict = classifyBridgeReply(
      {
        text: "Smoke is temporarily unavailable (no shared model configured).",
        degraded: true,
        transport: "shared-runtime",
      },
      TOKEN,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("degraded");
  });

  test("shared-runtime unavailable notice fails even without the degraded flag", () => {
    const verdict = classifyBridgeReply(
      {
        text: "Smoke is temporarily unavailable (no shared model configured).",
      },
      TOKEN,
    );
    expect(verdict.ok).toBe(false);
  });

  test("cloud-agent echo mode fails despite containing the token", () => {
    const verdict = classifyBridgeReply(
      {
        text: `[echo] Reply with one short sentence that contains the token ${TOKEN}.`,
      },
      TOKEN,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("echo");
  });

  test("a real reply that paraphrases the token away fails", () => {
    const verdict = classifyBridgeReply(
      { text: "Happy to help with your end-to-end test!" },
      TOKEN,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("proof token");
  });

  test("empty text fails", () => {
    expect(classifyBridgeReply({ text: "" }, TOKEN).ok).toBe(false);
    expect(classifyBridgeReply({ text: "   " }, TOKEN).ok).toBe(false);
  });

  test("missing or malformed result fails", () => {
    expect(classifyBridgeReply(undefined, TOKEN).ok).toBe(false);
    expect(classifyBridgeReply(null, TOKEN).ok).toBe(false);
    expect(classifyBridgeReply("text", TOKEN).ok).toBe(false);
    expect(classifyBridgeReply([], TOKEN).ok).toBe(false);
    expect(classifyBridgeReply({}, TOKEN).ok).toBe(false);
  });
});
