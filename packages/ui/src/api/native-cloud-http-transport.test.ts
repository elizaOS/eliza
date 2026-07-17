/**
 * Unit coverage for the native cloud transport: CapacitorHttp for direct cloud
 * hosts, fetch otherwise. CapacitorHttp mocked, no live cloud.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { capacitorState, capacitorHttpRequestMock } = vi.hoisted(() => ({
  capacitorState: { isNative: true },
  capacitorHttpRequestMock: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => capacitorState.isNative,
  },
  CapacitorHttp: {
    request: capacitorHttpRequestMock,
  },
}));

import { nativeCloudHttpTransportForUrl } from "./native-cloud-http-transport";

const AGENT_URL =
  "https://82e92cc6-6fab-4c4a-a1dc-7c1605aebfeb.elizacloud.ai/api/conversations/abc/messages/stream";
const API_URL = "https://api.elizacloud.ai/api/v1/eliza/agents";

let webFetchMock: ReturnType<typeof vi.fn>;
let globalFetchMock: ReturnType<typeof vi.fn>;
const originalWebFetch = (globalThis as { CapacitorWebFetch?: unknown })
  .CapacitorWebFetch;
const originalFetch = globalThis.fetch;

function streamResponse(): Response {
  return new Response("data: hi\n\n", {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

beforeEach(() => {
  capacitorState.isNative = true;
  capacitorHttpRequestMock.mockReset();
  capacitorHttpRequestMock.mockResolvedValue({
    status: 200,
    headers: {},
    data: "{}",
  });
  webFetchMock = vi.fn(async () => streamResponse());
  globalFetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
  (globalThis as { CapacitorWebFetch?: unknown }).CapacitorWebFetch =
    webFetchMock;
  globalThis.fetch = globalFetchMock as unknown as typeof fetch;
});

afterEach(() => {
  (globalThis as { CapacitorWebFetch?: unknown }).CapacitorWebFetch =
    originalWebFetch;
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("nativeCloudHttpTransportForUrl selection", () => {
  it("claims dedicated agent subdomains and the central cloud API", () => {
    expect(nativeCloudHttpTransportForUrl(AGENT_URL)).not.toBeNull();
    expect(nativeCloudHttpTransportForUrl(API_URL)).not.toBeNull();
  });

  it("ignores non-cloud hosts", () => {
    expect(
      nativeCloudHttpTransportForUrl("https://example.com/api/x"),
    ).toBeNull();
  });

  it("ignores look-alike hosts that only contain elizacloud.ai", () => {
    expect(
      nativeCloudHttpTransportForUrl("https://elizacloud.ai.evil.com/api"),
    ).toBeNull();
  });

  it("claims cloud web hosts for binary routing without treating them as agent SSE hosts", async () => {
    const url = "https://www.elizacloud.ai/api/x/messages/stream";
    const transport = nativeCloudHttpTransportForUrl(url);
    expect(transport).not.toBeNull();

    await transport?.request(url, {
      method: "GET",
      headers: { Accept: "text/event-stream" },
    });
    expect(globalFetchMock).toHaveBeenCalledTimes(1);
    expect(webFetchMock).not.toHaveBeenCalled();
    expect(capacitorHttpRequestMock).not.toHaveBeenCalled();
  });

  it("returns null off native platforms", () => {
    capacitorState.isNative = false;
    expect(nativeCloudHttpTransportForUrl(AGENT_URL)).toBeNull();
    expect(nativeCloudHttpTransportForUrl(API_URL)).toBeNull();
  });
});

describe("SSE streaming bypass", () => {
  it("streams SSE to an agent subdomain via the native browser fetch (not CapacitorHttp)", async () => {
    const transport = nativeCloudHttpTransportForUrl(AGENT_URL);
    expect(transport).not.toBeNull();
    const res = await transport?.request(AGENT_URL, {
      method: "POST",
      headers: { Accept: "text/event-stream" },
      body: "{}",
    });
    expect(webFetchMock).toHaveBeenCalledTimes(1);
    expect(capacitorHttpRequestMock).not.toHaveBeenCalled();
    expect(res?.body).not.toBeNull();
  });

  it("passes the native fetch's streaming body through incrementally — no buffering (#8773)", async () => {
    const encoder = new TextEncoder();
    let enqueueB: () => void = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("data: a\n\n"));
        enqueueB = () => {
          controller.enqueue(encoder.encode("data: b\n\n"));
          controller.close();
        };
      },
    });
    webFetchMock.mockResolvedValueOnce(
      new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );

    const transport = nativeCloudHttpTransportForUrl(AGENT_URL);
    const res = await transport?.request(AGENT_URL, {
      method: "POST",
      headers: { Accept: "text/event-stream" },
      body: "{}",
    });
    expect(res?.body).not.toBeNull();

    const reader = (res?.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();

    // The first chunk is readable BEFORE 'b' is enqueued — proving the transport
    // hands back the live streaming body (CapacitorHttp would have buffered the
    // whole response into one blob).
    const first = await reader.read();
    expect(decoder.decode(first.value)).toBe("data: a\n\n");

    enqueueB();
    const second = await reader.read();
    expect(decoder.decode(second.value)).toBe("data: b\n\n");
  });

  it("detects streaming by the /stream path even without the Accept header", async () => {
    const transport = nativeCloudHttpTransportForUrl(AGENT_URL);
    await transport?.request(AGENT_URL, { method: "POST", body: "{}" });
    expect(webFetchMock).toHaveBeenCalledTimes(1);
    expect(capacitorHttpRequestMock).not.toHaveBeenCalled();
  });

  it("does NOT use the native fetch for SSE to the central cloud API (CORS blocks the app origin there)", async () => {
    // api.elizacloud.ai does not serve CORS to the app origin, so its SSE
    // (e.g. computer-use/approvals/stream) must stay on CapacitorHttp's
    // CORS-bypass path — switching it to the native fetch would break it.
    const sseApiUrl =
      "https://api.elizacloud.ai/api/computer-use/approvals/stream";
    const transport = nativeCloudHttpTransportForUrl(sseApiUrl);
    await transport?.request(sseApiUrl, {
      method: "GET",
      headers: { Accept: "text/event-stream" },
    });
    expect(webFetchMock).not.toHaveBeenCalled();
    expect(capacitorHttpRequestMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to CapacitorHttp for SSE to an agent subdomain when the native fetch is unavailable", async () => {
    (globalThis as { CapacitorWebFetch?: unknown }).CapacitorWebFetch =
      undefined;
    const transport = nativeCloudHttpTransportForUrl(AGENT_URL);
    await transport?.request(AGENT_URL, {
      method: "POST",
      headers: { Accept: "text/event-stream" },
      body: "{}",
    });
    // No native fetch available → falls through to the global (patched) fetch,
    // since an agent subdomain is not a "direct cloud API" host.
    expect(globalFetchMock).toHaveBeenCalledTimes(1);
    expect(capacitorHttpRequestMock).not.toHaveBeenCalled();
  });
});

describe("non-streaming requests are unchanged", () => {
  it("routes non-SSE direct cloud API calls through CapacitorHttp", async () => {
    const transport = nativeCloudHttpTransportForUrl(API_URL);
    await transport?.request(API_URL, { method: "GET", headers: {} });
    expect(capacitorHttpRequestMock).toHaveBeenCalledTimes(1);
    expect(webFetchMock).not.toHaveBeenCalled();
  });

  it("routes non-SSE agent-subdomain calls through the patched global fetch", async () => {
    const agentNonStream =
      "https://82e92cc6-6fab-4c4a-a1dc-7c1605aebfeb.elizacloud.ai/api/agents";
    const transport = nativeCloudHttpTransportForUrl(agentNonStream);
    await transport?.request(agentNonStream, { method: "GET", headers: {} });
    expect(globalFetchMock).toHaveBeenCalledTimes(1);
    expect(capacitorHttpRequestMock).not.toHaveBeenCalled();
    expect(webFetchMock).not.toHaveBeenCalled();
  });
});

describe("binary cloud responses (#16106)", () => {
  const arbitraryAudio = new Uint8Array([
    0x52, 0x49, 0x46, 0x46, 0x80, 0xff, 0x00, 0xc3, 0x28,
  ]);
  const encodedAudio = btoa(
    Array.from(arbitraryAudio, (byte) => String.fromCharCode(byte)).join(""),
  );

  it.each([
    "https://api.elizacloud.ai/api/tts/cloud",
    "https://elizacloud.ai/api/v1/voice/tts",
    "https://agent-123.elizacloud.ai/api/v1/voice/tts",
  ])("preserves arbitrary audio bytes from %s", async (url) => {
    capacitorHttpRequestMock.mockResolvedValueOnce({
      status: 200,
      headers: { "content-type": "audio/wav" },
      data: encodedAudio,
    });
    const transport = nativeCloudHttpTransportForUrl(url);
    const response = await transport?.request(
      url,
      {
        method: "POST",
        headers: { Authorization: "Bearer secret", Accept: "audio/wav" },
        body: JSON.stringify({ text: "hello" }),
      },
      { responseType: "arraybuffer" },
    );

    expect(response).toBeDefined();
    expect(new Uint8Array(await (response as Response).arrayBuffer())).toEqual(
      arbitraryAudio,
    );
    expect(capacitorHttpRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        responseType: "arraybuffer",
        disableRedirects: true,
        headers: expect.objectContaining({ authorization: "Bearer secret" }),
      }),
    );
    expect(globalFetchMock).not.toHaveBeenCalled();
  });

  it("preserves JSON error bodies when the binary request fails (CapacitorHttp returns a parsed object)", async () => {
    // CapacitorHttp ignores responseType=arraybuffer for application/json and
    // hands back a parsed object; the transport must surface that error text
    // instead of blanking it through the base64 decoder.
    capacitorHttpRequestMock.mockResolvedValueOnce({
      status: 401,
      headers: { "content-type": "application/json" },
      data: { error: "invalid token" },
    });
    const url = "https://api.elizacloud.ai/api/v1/voice/tts";
    const response = await nativeCloudHttpTransportForUrl(url)?.request(
      url,
      {
        method: "POST",
        headers: { Authorization: "Bearer expired" },
        body: JSON.stringify({ text: "hello" }),
      },
      { responseType: "arraybuffer" },
    );

    expect(response?.status).toBe(401);
    expect(await (response as Response).text()).toContain("invalid token");
  });

  it("preserves string error bodies on non-2xx binary responses", async () => {
    capacitorHttpRequestMock.mockResolvedValueOnce({
      status: 400,
      headers: { "content-type": "text/plain" },
      data: "text is required",
    });
    const url = "https://api.elizacloud.ai/api/v1/voice/tts";
    const response = await nativeCloudHttpTransportForUrl(url)?.request(
      url,
      { method: "POST", headers: {}, body: "{}" },
      { responseType: "arraybuffer" },
    );

    expect(response?.status).toBe(400);
    expect(await (response as Response).text()).toBe("text is required");
  });

  it("surfaces a 302 without following or replaying its bearer", async () => {
    capacitorHttpRequestMock.mockResolvedValueOnce({
      status: 302,
      headers: { location: "https://attacker.example/audio" },
      data: "",
    });
    const url = "https://api.elizacloud.ai/api/tts/cloud";
    const response = await nativeCloudHttpTransportForUrl(url)?.request(
      url,
      {
        method: "POST",
        headers: { Authorization: "Bearer do-not-replay" },
        body: "{}",
      },
      { responseType: "arraybuffer" },
    );

    expect(response?.status).toBe(302);
    expect(capacitorHttpRequestMock).toHaveBeenCalledTimes(1);
    expect(capacitorHttpRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({ disableRedirects: true }),
    );
  });

  it.each([
    "/api/tts/cloud",
    "http://127.0.0.1:41337/api/tts/cloud",
    "eliza-local-agent://agent/api/tts/cloud",
  ])("does not claim local transport URL %s", (url) => {
    expect(nativeCloudHttpTransportForUrl(url)).toBeNull();
  });
});
