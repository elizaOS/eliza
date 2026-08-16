import { describe, expect, it, vi } from "vitest";

import { createCloudTextPrewarmer } from "../../src/routes/cloud-text-prewarm";

describe("local voice cloud text prewarm", () => {
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
    expect(useModel).toHaveBeenCalledTimes(1);
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

    release();
    await expect(first).resolves.toBe("warmed");
    await expect(concurrent).resolves.toBe("warmed");
    await expect(prewarm({ useModel })).resolves.toBe("already-warm");
    expect(useModel).toHaveBeenCalledTimes(1);

    now += 20_000;
    await expect(prewarm({ useModel })).resolves.toBe("warmed");
    expect(useModel).toHaveBeenCalledTimes(2);
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
    expect(useModel).toHaveBeenCalledTimes(1);
  });

  it("does not cache provider failures", async () => {
    const useModel = vi
      .fn()
      .mockRejectedValueOnce(new Error("provider unavailable"))
      .mockResolvedValueOnce("ok");
    const prewarm = createCloudTextPrewarmer();

    await expect(prewarm({ useModel })).rejects.toThrow("provider unavailable");
    await expect(prewarm({ useModel })).resolves.toBe("warmed");
    expect(useModel).toHaveBeenCalledTimes(2);
  });
});
