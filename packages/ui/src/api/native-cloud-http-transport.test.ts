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

  it("detects streaming by the /stream path even without the Accept header", async () => {
    const transport = nativeCloudHttpTransportForUrl(AGENT_URL);
    await transport?.request(AGENT_URL, { method: "POST", body: "{}" });
    expect(webFetchMock).toHaveBeenCalledTimes(1);
    expect(capacitorHttpRequestMock).not.toHaveBeenCalled();
  });

  it("streams SSE to the central cloud API via the native browser fetch", async () => {
    const sseApiUrl = "https://api.elizacloud.ai/api/chat/stream";
    const transport = nativeCloudHttpTransportForUrl(sseApiUrl);
    await transport?.request(sseApiUrl, {
      method: "POST",
      headers: { Accept: "text/event-stream" },
      body: "{}",
    });
    expect(webFetchMock).toHaveBeenCalledTimes(1);
    expect(capacitorHttpRequestMock).not.toHaveBeenCalled();
  });

  it("falls back to CapacitorHttp for SSE to the central API when the native fetch is unavailable", async () => {
    (globalThis as { CapacitorWebFetch?: unknown }).CapacitorWebFetch =
      undefined;
    const sseApiUrl = "https://api.elizacloud.ai/api/chat/stream";
    const transport = nativeCloudHttpTransportForUrl(sseApiUrl);
    await transport?.request(sseApiUrl, {
      method: "POST",
      headers: { Accept: "text/event-stream" },
      body: "{}",
    });
    expect(capacitorHttpRequestMock).toHaveBeenCalledTimes(1);
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
