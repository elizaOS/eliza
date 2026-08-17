import { describe, expect, it, vi } from "vitest";

import {
  createCloudTextPrewarmer,
  shouldPrewarmCloudTextGateway,
} from "../../src/routes/cloud-text-prewarm";

describe("local voice cloud text prewarm", () => {
  it("skips synthetic generations for an explicitly direct text route", () => {
    expect(
      shouldPrewarmCloudTextGateway(
        {
          llmText: { backend: "cerebras", transport: "direct" },
        },
        undefined
      )
    ).toBe(false);
  });

  it("skips when Cloud inference handlers are explicitly disabled", () => {
    expect(
      shouldPrewarmCloudTextGateway(
        {
          llmText: { backend: "elizacloud", transport: "cloud-proxy" },
        },
        " FALSE "
      )
    ).toBe(false);
  });

  it("preserves Cloud-proxy and legacy warmup eligibility", () => {
    expect(
      shouldPrewarmCloudTextGateway(
        {
          llmText: { backend: "elizacloud", transport: "cloud-proxy" },
        },
        "true"
      )
    ).toBe(true);
    expect(shouldPrewarmCloudTextGateway(undefined, undefined)).toBe(true);
  });

  it("refreshes the default warm lease before Cloud auth expires", async () => {
    let now = 1_000;
    const useModel = vi.fn(async () => "ok");
    const prewarm = createCloudTextPrewarmer({ now: () => now });

    await expect(prewarm({ useModel })).resolves.toBe("warmed");
    expect(useModel).toHaveBeenCalledTimes(2);

    now += 44_999;
    await expect(prewarm({ useModel })).resolves.toBe("already-warm");
    expect(useModel).toHaveBeenCalledTimes(2);

    now += 1;
    await expect(prewarm({ useModel })).resolves.toBe("warmed");
    expect(useModel).toHaveBeenCalledTimes(4);
  });

  it("coalesces concurrent probes and skips another probe inside the cooldown", async () => {
    let now = 1_000;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const useModel = vi.fn(async () => pending);
    const prewarm = createCloudTextPrewarmer({
      cooldownMs: 20_000,
      now: () => now,
    });

    const first = prewarm({ useModel });
    const concurrent = prewarm({ useModel });
    expect(useModel).toHaveBeenCalledTimes(2);
    expect(useModel).toHaveBeenCalledWith("RESPONSE_HANDLER", {
      prompt: "ping",
      maxTokens: 32,
      temperature: 0,
      stream: true,
      streamStructured: true,
      streamSecurity: "required",
      voiceOutput: "internal",
      onStreamChunk: expect.any(Function),
      responseSkeleton: {
        spans: [
          { kind: "literal", value: '{"replyText":' },
          { kind: "free-string", key: "replyText" },
          { kind: "literal", value: "}" },
        ],
      },
      tools: [
        {
          name: "HANDLE_RESPONSE",
          type: "function",
          strict: true,
          description: "Return one tiny warmup response.",
          parameters: {
            type: "object",
            properties: { replyText: { type: "string" } },
            required: ["replyText"],
            additionalProperties: false,
          },
        },
      ],
      toolChoice: "required",
      providerOptions: { eliza: { thinking: "off" } },
    });
    expect(useModel).toHaveBeenCalledWith("TEXT_LARGE", {
      prompt: "Reply with exactly one word: ready.",
      maxTokens: 32,
      temperature: 0,
      stream: true,
      streamCommittedReply: true,
      streamSecurity: "required",
      voiceOutput: "internal",
      onStreamChunk: expect.any(Function),
      providerOptions: { eliza: { thinking: "off" } },
    });

    release();
    await expect(first).resolves.toBe("warmed");
    await expect(concurrent).resolves.toBe("warmed");
    await expect(prewarm({ useModel })).resolves.toBe("already-warm");
    expect(useModel).toHaveBeenCalledTimes(2);

    now += 20_000;
    await expect(prewarm({ useModel })).resolves.toBe("warmed");
    expect(useModel).toHaveBeenCalledTimes(4);
  });

  it("accepts a zero-output completion as a successful transport warmup", async () => {
    const noOutput = new Error("no output");
    noOutput.name = "AI_NoOutputGeneratedError";
    const useModel = vi.fn(async () => {
      throw noOutput;
    });
    const prewarm = createCloudTextPrewarmer();

    await expect(prewarm({ useModel })).resolves.toBe("warmed");
    await expect(prewarm({ useModel })).resolves.toBe("already-warm");
    expect(useModel).toHaveBeenCalledTimes(2);
  });

  it("retains a successful lane when its sibling fails", async () => {
    const useModel = vi
      .fn()
      .mockRejectedValueOnce(new Error("provider unavailable"))
      .mockResolvedValueOnce("ok");
    const prewarm = createCloudTextPrewarmer();

    await expect(prewarm({ useModel })).rejects.toMatchObject({
      name: "CloudTextPrewarmError",
      lane: "response-handler",
      causeClass: "Error",
    });
    await expect(prewarm({ useModel })).resolves.toBe("warmed");
    expect(useModel).toHaveBeenCalledTimes(3);
    expect(useModel.mock.calls.map(([modelType]) => modelType)).toEqual([
      "RESPONSE_HANDLER",
      "TEXT_LARGE",
      "RESPONSE_HANDLER",
    ]);
  });
});
