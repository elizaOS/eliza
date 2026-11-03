import { describe, expect, it } from "vitest";
import {
  AFFILIATE_LABEL,
  answerTools,
  contextForReport,
  contextForScore,
  offersFor,
  toolsMessage,
} from "../src/offers.ts";
import { pollTelegramTools } from "../src/outside-read.ts";

describe("affiliate offers", () => {
  it("keeps every seeded partner off until a URL is pasted", () => {
    expect(offersFor("tools").length).toBe(0);
    expect(offersFor("extension").length).toBe(0);
    expect(toolsMessage()).toContain("No partner link is connected yet");
    expect(toolsMessage()).toContain(AFFILIATE_LABEL);
    expect(toolsMessage()).toContain("Not trading advice");
  });

  it("answers Telegram and desk /tools only", async () => {
    expect(answerTools("/tools")).toContain("Recommended tools");
    expect(answerTools("/tools@ValhallaBot")).toContain("Recommended tools");
    expect(answerTools("what is my pnl")).toBeNull();
    const sent: string[] = [];
    const next = await pollTelegramTools("test-token", 0, async (url, init) => {
      if (String(url).includes("getUpdates")) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: [
              { update_id: 4, message: { text: "/tools", chat: { id: 99 } } },
              { update_id: 5, message: { text: "hello", chat: { id: 99 } } },
            ],
          })
        );
      }
      sent.push(String(init?.body ?? ""));
      return new Response("{}", { status: 200 });
    });
    expect(next).toBe(6);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Recommended tools");
    expect(sent[0]).toContain("Not trading advice");
  });

  it("names the hardware wallet after a high-risk score and hides it for Pro", () => {
    expect(contextForScore(20)).toContain("Protect your coins: hardware wallet");
    expect(contextForScore(20)).toContain("Not trading advice");
    expect(contextForScore(90)).toBe("");
    expect(contextForScore(20, true)).toBe("");
  });

  it("names Chart better on the report card and hides it for Pro", () => {
    expect(contextForReport()).toBe("Chart better. Not trading advice.");
    expect(contextForReport(true)).toBe("");
  });
});
