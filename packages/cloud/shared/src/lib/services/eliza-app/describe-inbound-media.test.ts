/**
 * Pins the fail-closed contract of inbound-media vision enrichment: the flag
 * and provider gates throw the typed disabled error, every fetch/body-read/
 * cancellation/size/type/model failure throws the typed description error (so
 * callers degrade instead of dropping the turn), and a truncated or empty
 * completion is rejected, never returned. Deterministic mocks stand in for
 * safe-fetch, the provider factory, and the AI SDK — no network.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

class FakeProviderConfigurationError extends Error {
  override readonly name = "ProviderConfigurationError";
}

const safeFetch = mock<(url: string, init?: RequestInit) => Promise<Response>>(
  async () => new Response("unset", { status: 500 }),
);
const getLanguageModel = mock((_model: string): unknown => "vision-model");
const generateText = mock(
  async (_options: unknown): Promise<{ text: string; finishReason: string }> => ({
    text: "unset",
    finishReason: "stop",
  }),
);

mock.module("../../security/safe-fetch", () => ({ safeFetch }));
mock.module("../../providers/language-model", () => ({
  getLanguageModel,
  ProviderConfigurationError: FakeProviderConfigurationError,
}));
mock.module("ai", () => ({ generateText }));

const {
  describeInboundImageMedia,
  InboundMediaDescriptionError,
  InboundMediaVisionDisabledError,
  MAX_INBOUND_IMAGE_BYTES,
} = await import(`./describe-inbound-media.ts?test=describe-inbound-media-${Date.now()}`);

const ENABLED = { ELIZA_APP_INBOUND_MEDIA_VISION: "true" };
const URL_A = "https://media.blooio.com/files/photo-a.jpg";
const URL_B = "https://backend.blooio.com/files/photo-b.png";

function imageResponse(
  bytes: Uint8Array,
  contentType = "image/jpeg",
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(bytes, {
    status: 200,
    headers: { "content-type": contentType, ...extraHeaders },
  });
}

async function expectDescriptionFailure(
  promise: Promise<string>,
  reason: string,
): Promise<InstanceType<typeof InboundMediaDescriptionError>> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(InboundMediaDescriptionError);
  const typed = caught as InstanceType<typeof InboundMediaDescriptionError>;
  expect(typed.reason).toBe(reason as never);
  return typed;
}

describe("describeInboundImageMedia — fail-closed gates", () => {
  beforeEach(() => {
    safeFetch.mockReset();
    getLanguageModel.mockReset();
    generateText.mockReset();
    getLanguageModel.mockReturnValue("vision-model");
    generateText.mockResolvedValue({
      text: "a described image",
      finishReason: "stop",
    });
    safeFetch.mockResolvedValue(imageResponse(new Uint8Array([1, 2, 3])));
  });

  test("unset flag throws the disabled error before any fetch", async () => {
    await expect(describeInboundImageMedia({}, [URL_A])).rejects.toBeInstanceOf(
      InboundMediaVisionDisabledError,
    );
    expect(safeFetch).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();
  });

  test('any non-"true" flag value stays disabled', async () => {
    await expect(
      describeInboundImageMedia({ ELIZA_APP_INBOUND_MEDIA_VISION: "1" }, [URL_A]),
    ).rejects.toBeInstanceOf(InboundMediaVisionDisabledError);
    expect(safeFetch).not.toHaveBeenCalled();
  });

  test("missing vision provider is retyped as disabled, before any fetch", async () => {
    getLanguageModel.mockImplementation(() => {
      throw new FakeProviderConfigurationError("no key");
    });
    let caught: unknown;
    try {
      await describeInboundImageMedia(ENABLED, [URL_A]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InboundMediaVisionDisabledError);
    expect((caught as Error).cause).toBeInstanceOf(FakeProviderConfigurationError);
    expect(safeFetch).not.toHaveBeenCalled();
  });

  test("a non-configuration provider-factory failure propagates untyped", async () => {
    const bug = new Error("factory bug");
    getLanguageModel.mockImplementation(() => {
      throw bug;
    });
    await expect(describeInboundImageMedia(ENABLED, [URL_A])).rejects.toBe(bug);
  });

  test("a URL off the Blooio allowlist is a contract violation, not a degrade", async () => {
    let caught: unknown;
    try {
      await describeInboundImageMedia(ENABLED, ["https://evil.example/a.jpg"]);
    } catch (error) {
      caught = error;
    }
    expect(caught).not.toBeInstanceOf(InboundMediaDescriptionError);
    expect((caught as { code?: string }).code).toBe("INBOUND_MEDIA_URL_DISALLOWED");
    expect(safeFetch).not.toHaveBeenCalled();
  });

  test("zero and above-max URL counts are contract violations", async () => {
    for (const urls of [[], [URL_A, URL_A, URL_A, URL_A, URL_A]]) {
      let caught: unknown;
      try {
        await describeInboundImageMedia(ENABLED, urls);
      } catch (error) {
        caught = error;
      }
      expect((caught as { code?: string }).code).toBe("INBOUND_MEDIA_URL_COUNT_INVALID");
    }
  });
});

describe("describeInboundImageMedia — enrichment path", () => {
  beforeEach(() => {
    safeFetch.mockReset();
    getLanguageModel.mockReset();
    generateText.mockReset();
    getLanguageModel.mockReturnValue("vision-model");
    generateText.mockResolvedValue({
      text: "  a cat on a keyboard  ",
      finishReason: "stop",
    });
  });

  test("fetches every URL through the SSRF guard and sends bytes as image parts", async () => {
    const bytesA = new Uint8Array([1, 2, 3]);
    const bytesB = new Uint8Array([4, 5]);
    safeFetch.mockImplementation(async (url) =>
      url === URL_A ? imageResponse(bytesA, "image/jpeg") : imageResponse(bytesB, "image/png"),
    );

    const description = await describeInboundImageMedia(ENABLED, [URL_A, URL_B]);

    expect(description).toBe("a cat on a keyboard");
    expect(safeFetch.mock.calls.map((call) => call[0])).toEqual([URL_A, URL_B]);
    expect(getLanguageModel).toHaveBeenCalledWith("openai/gpt-5.4-mini");
    const options = generateText.mock.calls[0]?.[0] as {
      messages: Array<{
        role: string;
        content: Array<
          { type: "text"; text: string } | { type: "image"; image: Uint8Array; mediaType: string }
        >;
      }>;
      maxOutputTokens: number;
    };
    expect(options.messages).toHaveLength(1);
    const [textPart, imageA, imageB] = options.messages[0].content;
    expect(textPart.type).toBe("text");
    expect(imageA).toEqual({
      type: "image",
      image: bytesA,
      mediaType: "image/jpeg",
    });
    expect(imageB).toEqual({
      type: "image",
      image: bytesB,
      mediaType: "image/png",
    });
    expect(options.maxOutputTokens).toBeGreaterThan(0);
  });

  test("every media fetch forbids redirects so hops cannot leave the allowlist", async () => {
    safeFetch.mockImplementation(async () => imageResponse(new Uint8Array([1, 2, 3])));

    await describeInboundImageMedia(ENABLED, [URL_A, URL_B]);

    expect(safeFetch).toHaveBeenCalledTimes(2);
    for (const call of safeFetch.mock.calls) {
      expect((call[1] as { redirect?: string } | undefined)?.redirect).toBe("error");
    }
  });

  test("a mixed fetch outcome waits for every sibling to settle before failing", async () => {
    let slowSiblingSettled = false;
    safeFetch.mockImplementation(async (url) => {
      if (url === URL_A) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        slowSiblingSettled = true;
        return imageResponse(new Uint8Array([1, 2, 3]));
      }
      throw new Error("connect refused");
    });

    const error = await expectDescriptionFailure(
      describeInboundImageMedia(ENABLED, [URL_A, URL_B]),
      "media_fetch_failed",
    );

    expect(slowSiblingSettled).toBe(true);
    expect(error.context).toMatchObject({ reason: "media_fetch_failed", url: URL_B });
    expect(generateText).not.toHaveBeenCalled();
  });

  test("transport failure from the SSRF guard becomes media_fetch_failed", async () => {
    const transport = new Error("connect refused");
    safeFetch.mockRejectedValue(transport);
    const error = await expectDescriptionFailure(
      describeInboundImageMedia(ENABLED, [URL_A]),
      "media_fetch_failed",
    );
    expect(error.cause).toBe(transport);
    expect(generateText).not.toHaveBeenCalled();
  });

  test("non-2xx media response becomes media_fetch_failed", async () => {
    safeFetch.mockResolvedValue(new Response("gone", { status: 404 }));
    await expectDescriptionFailure(
      describeInboundImageMedia(ENABLED, [URL_A]),
      "media_fetch_failed",
    );
  });

  test("non-image content type becomes unsupported_media_type", async () => {
    safeFetch.mockResolvedValue(imageResponse(new Uint8Array([1]), "application/pdf"));
    await expectDescriptionFailure(
      describeInboundImageMedia(ENABLED, [URL_A]),
      "unsupported_media_type",
    );
    expect(generateText).not.toHaveBeenCalled();
  });

  test("a declared Content-Length above the ceiling is rejected before reading", async () => {
    safeFetch.mockResolvedValue(
      imageResponse(new Uint8Array([1]), "image/jpeg", {
        "content-length": String(MAX_INBOUND_IMAGE_BYTES + 1),
      }),
    );
    await expectDescriptionFailure(describeInboundImageMedia(ENABLED, [URL_A]), "media_too_large");
  });

  test("a streamed body above the ceiling is rejected even without Content-Length", async () => {
    const chunk = new Uint8Array(4 * 1024 * 1024);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.close();
      },
    });
    safeFetch.mockResolvedValue(
      new Response(stream, {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      }),
    );
    await expectDescriptionFailure(describeInboundImageMedia(ENABLED, [URL_A]), "media_too_large");
    expect(generateText).not.toHaveBeenCalled();
  });

  test("a body stream that errors mid-read becomes media_read_failed", async () => {
    const streamFault = new TypeError("terminated");
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        // First pull delivers bytes; the connection drops on the second.
        if (pulls++ === 0) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
        } else {
          controller.error(streamFault);
        }
      },
    });
    safeFetch.mockResolvedValue(
      new Response(stream, { status: 200, headers: { "content-type": "image/jpeg" } }),
    );
    const error = await expectDescriptionFailure(
      describeInboundImageMedia(ENABLED, [URL_A]),
      "media_read_failed",
    );
    expect(error.cause).toBe(streamFault);
    expect(error.context).toMatchObject({ url: URL_A, bytesRead: 3 });
    expect(generateText).not.toHaveBeenCalled();
  });

  test("a fetch timeout that fires during the body read becomes media_read_failed", async () => {
    const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(timeout);
      },
    });
    safeFetch.mockResolvedValue(
      new Response(stream, { status: 200, headers: { "content-type": "image/jpeg" } }),
    );
    const error = await expectDescriptionFailure(
      describeInboundImageMedia(ENABLED, [URL_A]),
      "media_read_failed",
    );
    expect(error.cause).toBe(timeout);
    expect(generateText).not.toHaveBeenCalled();
  });

  test("a failing cancel while discarding a body keeps the typed degrade error", async () => {
    const bodyThatCannotCancel = () =>
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(4 * 1024 * 1024));
        },
        cancel() {
          throw new Error("socket already closed");
        },
      });
    // Declared above the ceiling: discarded before any read.
    safeFetch.mockResolvedValue(
      new Response(bodyThatCannotCancel(), {
        status: 200,
        headers: {
          "content-type": "image/jpeg",
          "content-length": String(MAX_INBOUND_IMAGE_BYTES + 1),
        },
      }),
    );
    await expectDescriptionFailure(describeInboundImageMedia(ENABLED, [URL_A]), "media_too_large");
    // Not an image: discarded before any read.
    safeFetch.mockResolvedValue(
      new Response(bodyThatCannotCancel(), {
        status: 200,
        headers: { "content-type": "application/pdf" },
      }),
    );
    await expectDescriptionFailure(
      describeInboundImageMedia(ENABLED, [URL_A]),
      "unsupported_media_type",
    );
    // Non-2xx: discarded before any read.
    safeFetch.mockResolvedValue(new Response(bodyThatCannotCancel(), { status: 503 }));
    await expectDescriptionFailure(
      describeInboundImageMedia(ENABLED, [URL_A]),
      "media_fetch_failed",
    );
    // Streamed past the ceiling without Content-Length: discarded mid-read.
    safeFetch.mockResolvedValue(
      new Response(bodyThatCannotCancel(), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      }),
    );
    await expectDescriptionFailure(describeInboundImageMedia(ENABLED, [URL_A]), "media_too_large");
    expect(generateText).not.toHaveBeenCalled();
  });

  test("an empty media body is a fetch failure, not an empty image", async () => {
    safeFetch.mockResolvedValue(imageResponse(new Uint8Array(0)));
    await expectDescriptionFailure(
      describeInboundImageMedia(ENABLED, [URL_A]),
      "media_fetch_failed",
    );
  });

  test("vision-model rejection becomes vision_model_failed", async () => {
    safeFetch.mockResolvedValue(imageResponse(new Uint8Array([1])));
    const upstream = new Error("upstream 500");
    generateText.mockRejectedValue(upstream);
    const error = await expectDescriptionFailure(
      describeInboundImageMedia(ENABLED, [URL_A]),
      "vision_model_failed",
    );
    expect(error.cause).toBe(upstream);
  });

  test("an empty completion is rejected, never returned as a description", async () => {
    safeFetch.mockResolvedValue(imageResponse(new Uint8Array([1])));
    generateText.mockResolvedValue({ text: "   ", finishReason: "stop" });
    await expectDescriptionFailure(
      describeInboundImageMedia(ENABLED, [URL_A]),
      "empty_description",
    );
  });

  test("prompt integrity: a completion clipped at the output ceiling is rejected", async () => {
    safeFetch.mockResolvedValue(imageResponse(new Uint8Array([1])));
    generateText.mockResolvedValue({
      text: "a partial descrip",
      finishReason: "length",
    });
    await expectDescriptionFailure(
      describeInboundImageMedia(ENABLED, [URL_A]),
      "incomplete_description",
    );
  });
});
