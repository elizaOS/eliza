/**
 * downloadMedia must enforce maxBytes while reading the body, not after
 * buffering it: chunked responses carry no Content-Length and a declared
 * length can understate the real payload.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { GoogleChatService } from "./service.ts";
import { GoogleChatApiError } from "./types.ts";

const CHUNK = 1024;
const TOTAL_CHUNKS = 1000;

function streamingBody(totalChunks: number) {
  let pulled = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= totalChunks) {
        controller.close();
        return;
      }
      pulled += 1;
      controller.enqueue(new Uint8Array(CHUNK));
    },
    cancel() {
      cancelled = true;
    },
  });
  return { stream, pulled: () => pulled, cancelled: () => cancelled };
}

function serviceReturning(response: Response) {
  const runtime = { emitEvent: vi.fn() } as unknown as IAgentRuntime;
  const service = new GoogleChatService(runtime);
  vi.spyOn(service, "getAccessToken").mockResolvedValue("token");
  service.fetchImpl = (async () => response) as unknown as typeof fetch;
  return service;
}

async function expectRejectedAsTooLarge(promise: Promise<unknown>) {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(GoogleChatApiError);
  expect((error as GoogleChatApiError).statusCode).toBe(413);
}

describe("GoogleChatService.downloadMedia size limit", () => {
  it("stops reading a chunked body without content-length once it exceeds maxBytes", async () => {
    const body = streamingBody(TOTAL_CHUNKS);
    const response = new Response(body.stream, {
      headers: { "content-type": "image/png" },
    });
    expect(response.headers.get("content-length")).toBeNull();
    const service = serviceReturning(response);

    await expectRejectedAsTooLarge(service.downloadMedia("spaces/AAA/attachments/X", 4 * CHUNK));
    expect(body.cancelled()).toBe(true);
    expect(body.pulled()).toBeLessThan(TOTAL_CHUNKS);
  });

  it("rejects a body larger than an understated content-length", async () => {
    const body = streamingBody(TOTAL_CHUNKS);
    const response = new Response(body.stream, {
      headers: { "content-length": String(CHUNK), "content-type": "image/png" },
    });
    const service = serviceReturning(response);

    await expectRejectedAsTooLarge(service.downloadMedia("spaces/AAA/attachments/X", 4 * CHUNK));
    expect(body.cancelled()).toBe(true);
    expect(body.pulled()).toBeLessThan(TOTAL_CHUNKS);
  });

  it("returns media within the limit", async () => {
    const body = streamingBody(3);
    const service = serviceReturning(
      new Response(body.stream, { headers: { "content-type": "image/png" } })
    );

    const result = await service.downloadMedia("spaces/AAA/attachments/X", 4 * CHUNK);

    expect(result.buffer.length).toBe(3 * CHUNK);
    expect(result.contentType).toBe("image/png");
  });
});
