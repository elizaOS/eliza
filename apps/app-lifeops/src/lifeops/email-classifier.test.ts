import { type IAgentRuntime, ModelType } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetEmailClassifierCache,
  classifyEmail,
  classifyEmailByRules,
  isEmailClassifierEnabled,
} from "./email-classifier.js";

function runtime(settings: Record<string, unknown> = {}): IAgentRuntime {
  return {
    getSetting: vi.fn((key: string) => settings[key]),
    useModel: vi.fn(),
  } as unknown as IAgentRuntime;
}

beforeEach(() => {
  _resetEmailClassifierCache();
});

describe("email classifier", () => {
  it("classifies obvious billing mail without invoking the model", async () => {
    const rt = runtime();
    const result = await classifyEmail(rt, {
      id: "m-1",
      subject: "Your April invoice is ready",
      fromEmail: "billing@example.com",
      snippet: "Amount due $42.00",
    });

    expect(result.category).toBe("bill");
    expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    expect(rt.useModel).not.toHaveBeenCalled();
  });

  it("uses the configured model for ambiguous mail", async () => {
    const rt = runtime({ "lifeops.emailClassifier.model": "TEXT_LARGE" });
    vi.mocked(rt.useModel).mockResolvedValueOnce(
      JSON.stringify({
        category: "personal",
        confidence: 0.82,
        signals: ["human_sender"],
      }),
    );

    const result = await classifyEmail(rt, {
      id: "m-2",
      subject: "question",
      from: "Alice <alice@example.com>",
      snippet: "Can you look at this today?",
    });

    expect(result).toEqual({
      category: "personal",
      confidence: 0.82,
      signals: ["human_sender"],
    });
    expect(rt.useModel).toHaveBeenCalledWith(ModelType.TEXT_LARGE, {
      prompt: expect.stringContaining("Classify this email"),
    });
  });

  it("returns a disabled classification when the setting is false", async () => {
    const rt = runtime({ "lifeops.emailClassifier.enabled": "false" });

    expect(isEmailClassifierEnabled(rt)).toBe(false);
    await expect(
      classifyEmail(rt, {
        id: "m-disabled",
        subject: "Invoice due",
        fromEmail: "billing@example.com",
      }),
    ).resolves.toEqual({
      category: "personal",
      confidence: 0,
      signals: ["disabled"],
    });
    expect(rt.useModel).not.toHaveBeenCalled();
  });

  it("falls back to the rule result when the model fails", async () => {
    const rt = runtime();
    vi.mocked(rt.useModel).mockRejectedValueOnce(new Error("model offline"));

    const result = await classifyEmail(rt, {
      id: "m-3",
      subject: "Your statement",
      fromEmail: "news@example.com",
      snippet: "Your statement is attached.",
    });

    expect(result.category).toBe("bill");
    expect(result.signals).toContain("bill_subject");
  });

  it("short-circuits known contacts as personal mail", () => {
    const result = classifyEmailByRules(
      {
        subject: "Invoice for dinner",
        fromEmail: "friend@example.com",
      },
      { knownContacts: new Set(["friend@example.com"]) },
    );

    expect(result).toEqual({
      category: "personal",
      confidence: 0.85,
      signals: ["known_contact"],
    });
  });
});
