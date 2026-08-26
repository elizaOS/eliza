/** Exercises fal video submission and reconciliation with deterministic provider fixtures. */
import { describe, expect, mock, test } from "bun:test";

const falActual = require("@fal-ai/client") as typeof import("@fal-ai/client");
const { ApiError } = falActual;

const subscribe = mock();
const queueStatus = mock();
const queueResult = mock();
const createFalClient = mock(() => ({
  subscribe,
  queue: { status: queueStatus, result: queueResult },
}));

mock.module("@fal-ai/client", () => ({
  ...falActual,
  createFalClient,
}));

const {
  buildFalVideoInput,
  falVideoProvider,
  generateFalVideo,
  getFalVideoJobStatus,
  normalizeFalVideoResult,
} = await import("./fal-video-generation");
const {
  VideoGenerationPendingError,
  VideoGenerationSubmissionUnknownError,
  VideoGenerationTerminalError,
} = await import("./types");

describe("FAL video provider", () => {
  test("maps Cloud video request fields to FAL input aliases", () => {
    expect(
      buildFalVideoInput({
        model: "fal-ai/veo3",
        prompt: "city timelapse",
        referenceUrl: "https://example.com/ref.png",
        durationSeconds: 8,
        resolution: "1080p",
        audio: true,
        voiceControl: false,
        apiKeys: { FAL_KEY: "fal-key" },
      }),
    ).toEqual({
      prompt: "city timelapse",
      image_url: "https://example.com/ref.png",
      duration: 8,
      duration_seconds: 8,
      resolution: "1080p",
      audio: true,
      generate_audio: true,
      voice_control: false,
    });
  });

  test("builds the MiniMax H3 Max image-to-video input contract", () => {
    expect(
      buildFalVideoInput({
        model: "minimax/h3-max/image-to-video",
        prompt: "the subject turns toward the camera",
        referenceUrl: "https://example.com/start.png",
        durationSeconds: 5,
        resolution: "768P",
        audio: true,
        apiKeys: { FAL_KEY: "fal-key" },
      }),
    ).toEqual({
      prompt: "the subject turns toward the camera",
      image_url: "https://example.com/start.png",
      duration: 5,
      resolution: "768P",
      prompt_expansion_mode: "balanced",
    });
  });

  test("maps Seedance 2.5 controls to its exact fal schema", () => {
    expect(
      buildFalVideoInput({
        model: "bytedance/seedance-2.5/image-to-video",
        prompt: "the puppy looks up and wags its tail",
        referenceUrl: "https://example.com/puppy.png",
        durationSeconds: 5,
        resolution: "720p",
        audio: true,
        aspectRatio: "auto",
        seed: 42,
        endUserId: "user-123",
        apiKeys: { FAL_KEY: "fal-key" },
      }),
    ).toEqual({
      prompt: "the puppy looks up and wags its tail",
      image_url: "https://example.com/puppy.png",
      duration: "5",
      resolution: "720p",
      generate_audio: true,
      aspect_ratio: "auto",
      seed: 42,
      end_user_id: "user-123",
    });
  });

  test("normalizes FAL video responses with request id fallback", () => {
    expect(
      normalizeFalVideoResult(
        {
          videos: [
            {
              url: "https://fal.media/out.mp4",
              width: 1920,
              height: 1080,
              file_name: "out.mp4",
              file_size: 1234,
              content_type: "video/mp4",
            },
          ],
          seed: 99,
          timings: { inference: 1.25 },
          has_nsfw_concepts: [false],
        },
        "queued-id",
      ),
    ).toEqual({
      requestId: "queued-id",
      video: {
        url: "https://fal.media/out.mp4",
        width: 1920,
        height: 1080,
        file_name: "out.mp4",
        file_size: 1234,
        content_type: "video/mp4",
      },
      seed: 99,
      timings: { inference: 1.25 },
      hasNsfwConcepts: [false],
    });
  });

  test("generates through the registered FAL provider", async () => {
    createFalClient.mockClear();
    subscribe.mockClear();
    subscribe.mockImplementation(async (_model, options) => {
      options.onEnqueue("queued-id");
      return {
        request_id: "result-id",
        video: { url: "https://fal.media/out.mp4" },
      };
    });

    const result = await generateFalVideo({
      model: "fal-ai/veo3",
      prompt: "a lighthouse",
      durationSeconds: 5,
      apiKeys: { FAL_API_KEY: "fal-key" },
    });

    expect(falVideoProvider.billingSource).toBe("fal");
    expect(falVideoProvider.isConfigured?.({ FAL_KEY: " fal-key " })).toBe(true);
    expect(createFalClient).toHaveBeenCalledWith({
      credentials: "fal-key",
      suppressLocalCredentialsWarning: true,
    });
    expect(subscribe).toHaveBeenCalledWith("fal-ai/veo3", {
      input: {
        prompt: "a lighthouse",
        duration: 5,
        duration_seconds: 5,
      },
      onEnqueue: expect.any(Function),
    });
    expect(result).toEqual({
      requestId: "result-id",
      video: { url: "https://fal.media/out.mp4" },
      timings: null,
      hasNsfwConcepts: undefined,
      seed: undefined,
    });
  });

  test("prefers the canonical FAL_API_KEY when both deployment keys exist", async () => {
    createFalClient.mockClear();
    subscribe.mockImplementationOnce(async () => ({
      request_id: "canonical-key-result",
      video: { url: "https://fal.media/canonical.mp4" },
    }));

    await generateFalVideo({
      model: "fal-ai/veo3",
      prompt: "a lighthouse",
      apiKeys: { FAL_KEY: "stale-legacy-key", FAL_API_KEY: "canonical-key" },
    });

    expect(createFalClient).toHaveBeenCalledWith({
      credentials: "canonical-key",
      suppressLocalCredentialsWarning: true,
    });
  });

  test("rejects missing FAL credentials before calling upstream", async () => {
    createFalClient.mockClear();

    await expect(
      generateFalVideo({
        model: "fal-ai/veo3",
        prompt: "a lighthouse",
        apiKeys: {},
      }),
    ).rejects.toThrow("AI services are not configured on this deployment");
    expect(falVideoProvider.isConfigured?.({})).toBe(false);
    expect(createFalClient).not.toHaveBeenCalled();
  });

  test("unwraps the @fal-ai/client Result envelope ({ data, requestId })", () => {
    expect(
      normalizeFalVideoResult(
        {
          data: { video: { url: "https://fal.media/out.mp4" } },
          requestId: "envelope-id",
        },
        "fallback-id",
      ),
    ).toEqual({
      requestId: "envelope-id",
      video: { url: "https://fal.media/out.mp4" },
      timings: null,
      hasNsfwConcepts: undefined,
      seed: undefined,
    });
  });
});

const REQ = { model: "fal-ai/veo3", requestId: "req-42", apiKeys: { FAL_KEY: "fal-key" } };

function resetFalMocks() {
  subscribe.mockReset();
  queueStatus.mockReset();
  queueResult.mockReset();
}

describe("getFalVideoJobStatus — upstream terminal-state verification (#11862)", () => {
  test("COMPLETED job with a result → succeeded with the normalized video", async () => {
    resetFalMocks();
    queueStatus.mockResolvedValue({ status: "COMPLETED" });
    queueResult.mockResolvedValue({
      data: { video: { url: "https://fal.media/late.mp4" } },
      requestId: "req-42",
    });

    const status = await getFalVideoJobStatus(REQ);

    expect(status).toEqual({
      state: "succeeded",
      result: {
        requestId: "req-42",
        video: { url: "https://fal.media/late.mp4" },
        timings: null,
        hasNsfwConcepts: undefined,
        seed: undefined,
      },
    });
    expect(queueStatus).toHaveBeenCalledWith("fal-ai/veo3", { requestId: "req-42" });
    expect(queueResult).toHaveBeenCalledWith("fal-ai/veo3", { requestId: "req-42" });
  });

  test("IN_QUEUE / IN_PROGRESS → pending", async () => {
    resetFalMocks();
    queueStatus.mockResolvedValueOnce({ status: "IN_QUEUE", queue_position: 3 });
    expect(await getFalVideoJobStatus(REQ)).toEqual({ state: "pending" });
    queueStatus.mockResolvedValueOnce({ status: "IN_PROGRESS", logs: [] });
    expect(await getFalVideoJobStatus(REQ)).toEqual({ state: "pending" });
    expect(queueResult).not.toHaveBeenCalled();
  });

  test("unknown request id (404) → verified failure", async () => {
    resetFalMocks();
    queueStatus.mockRejectedValue(
      new ApiError({ message: "Not found", status: 404, body: undefined }),
    );

    const status = await getFalVideoJobStatus(REQ);
    expect(status.state).toBe("failed");
  });

  test("COMPLETED job whose result endpoint rejects with 4xx → verified failure", async () => {
    resetFalMocks();
    queueStatus.mockResolvedValue({ status: "COMPLETED" });
    queueResult.mockRejectedValue(
      new ApiError({ message: "render failed", status: 422, body: undefined }),
    );

    const status = await getFalVideoJobStatus(REQ);
    expect(status).toEqual({ state: "failed", error: "render failed" });
  });

  test("COMPLETED job whose result endpoint is rate limited stays inconclusive", async () => {
    resetFalMocks();
    queueStatus.mockResolvedValue({ status: "COMPLETED" });
    queueResult.mockRejectedValue(
      new ApiError({ message: "rate limited", status: 429, body: undefined }),
    );

    await expect(getFalVideoJobStatus(REQ)).rejects.toMatchObject({
      message: "rate limited",
      status: 429,
    });
  });

  test("transport failure on the status probe propagates (never a failed verdict)", async () => {
    resetFalMocks();
    queueStatus.mockRejectedValue(new Error("network unreachable"));
    await expect(getFalVideoJobStatus(REQ)).rejects.toThrow("network unreachable");
  });
});

describe("generateFalVideo — post-enqueue failures never present as refundable (#11862)", () => {
  const request = {
    model: "fal-ai/veo3",
    prompt: "a lighthouse",
    apiKeys: { FAL_KEY: "fal-key" },
  };

  function subscribeFailsAfterEnqueue() {
    subscribe.mockImplementation(async (_model: string, options: Record<string, unknown>) => {
      (options.onEnqueue as (id: string) => void)("req-42");
      throw new Error("poll timed out");
    });
  }

  test("poll failure with the job still running → VideoGenerationPendingError", async () => {
    resetFalMocks();
    subscribeFailsAfterEnqueue();
    queueStatus.mockResolvedValue({ status: "IN_PROGRESS", logs: [] });

    const error = await generateFalVideo(request).then(
      () => {
        throw new Error("expected rejection");
      },
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(VideoGenerationPendingError);
    expect((error as InstanceType<typeof VideoGenerationPendingError>).requestId).toBe("req-42");
  });

  test("poll failure but the job already completed → recovered video, no error", async () => {
    resetFalMocks();
    subscribeFailsAfterEnqueue();
    queueStatus.mockResolvedValue({ status: "COMPLETED" });
    queueResult.mockResolvedValue({
      data: { video: { url: "https://fal.media/recovered.mp4" } },
      requestId: "req-42",
    });

    const result = await generateFalVideo(request);
    expect(result.video.url).toBe("https://fal.media/recovered.mp4");
  });

  test("poll failure with a verified terminal failure → typed terminal error", async () => {
    resetFalMocks();
    subscribeFailsAfterEnqueue();
    queueStatus.mockRejectedValue(
      new ApiError({ message: "Not found", status: 404, body: undefined }),
    );

    const error = await generateFalVideo(request).catch((caught) => caught);
    expect(error).toBeInstanceOf(VideoGenerationTerminalError);
    expect(
      (error as InstanceType<typeof VideoGenerationTerminalError>).providerCause,
    ).toBeInstanceOf(Error);
  });

  test("poll failure with an unreachable status probe → VideoGenerationPendingError", async () => {
    resetFalMocks();
    subscribeFailsAfterEnqueue();
    queueStatus.mockRejectedValue(new Error("network unreachable"));

    await expect(generateFalVideo(request)).rejects.toBeInstanceOf(VideoGenerationPendingError);
  });

  test("poll failure with a rate-limited completed-result probe stays pending", async () => {
    resetFalMocks();
    subscribeFailsAfterEnqueue();
    queueStatus.mockResolvedValue({ status: "COMPLETED" });
    queueResult.mockRejectedValue(
      new ApiError({ message: "rate limited", status: 429, body: undefined }),
    );

    const error = await generateFalVideo(request).catch((caught) => caught);
    expect(error).toBeInstanceOf(VideoGenerationPendingError);
    expect((error as InstanceType<typeof VideoGenerationPendingError>).requestId).toBe("req-42");
  });

  test("definitive pre-enqueue rejection is safe for provider fallback", async () => {
    resetFalMocks();
    subscribe.mockRejectedValue(
      new ApiError({
        message: "invalid input",
        status: 422,
        body: undefined,
      }),
    );

    await expect(generateFalVideo(request)).rejects.toBeInstanceOf(VideoGenerationTerminalError);
    expect(queueStatus).not.toHaveBeenCalled();
  });

  test("pre-enqueue 5xx response is terminal: no request id was ever issued", async () => {
    resetFalMocks();
    subscribe.mockRejectedValue(
      new ApiError({
        message: "fal upstream 503",
        status: 503,
        body: undefined,
      }),
    );

    const error = await generateFalVideo(request).catch((caught) => caught);
    expect(error).toBeInstanceOf(VideoGenerationTerminalError);
    expect(
      (error as InstanceType<typeof VideoGenerationTerminalError>).providerCause,
    ).toMatchObject({ status: 503 });
    expect(queueStatus).not.toHaveBeenCalled();
  });

  test("pre-enqueue rate limit is terminal: fal created no job", async () => {
    resetFalMocks();
    subscribe.mockRejectedValue(
      new ApiError({ message: "rate limited", status: 429, body: undefined }),
    );

    await expect(generateFalVideo(request)).rejects.toBeInstanceOf(VideoGenerationTerminalError);
    expect(queueStatus).not.toHaveBeenCalled();
  });

  test("pre-enqueue transport ambiguity cannot dispatch a paid fallback", async () => {
    resetFalMocks();
    subscribe.mockRejectedValue(new Error("connection reset after upload"));

    const error = await generateFalVideo(request).catch((caught) => caught);
    expect(error).toBeInstanceOf(VideoGenerationSubmissionUnknownError);
    expect(
      (error as InstanceType<typeof VideoGenerationSubmissionUnknownError>).providerCause,
    ).toBeInstanceOf(Error);
    expect(queueStatus).not.toHaveBeenCalled();
  });
});
