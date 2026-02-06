import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  createSignalEventStream,
  normalizeBaseUrl,
  parseSignalEventData,
  signalCheck,
  signalGetVersion,
  signalListAccounts,
  signalListContacts,
  signalListGroups,
  signalRpcRequest,
  signalSend,
  signalSendReaction,
  signalSendReadReceipt,
  signalSendTyping,
} from "../src/rpc";

// Mock global fetch
const mockFetch = vi.fn();
const originalFetch = global.fetch;

beforeAll(() => {
  global.fetch = mockFetch as typeof global.fetch;
});

afterAll(() => {
  global.fetch = originalFetch;
});

/**
 * Tests for Signal RPC client
 */
describe("Signal RPC", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("normalizeBaseUrl", () => {
    it("should throw for empty URL", () => {
      expect(() => normalizeBaseUrl("")).toThrow("Signal base URL is required");
    });

    it("should throw for whitespace-only URL", () => {
      expect(() => normalizeBaseUrl("   ")).toThrow(
        "Signal base URL is required",
      );
    });

    it("should preserve http:// prefix", () => {
      expect(normalizeBaseUrl("http://localhost:8080")).toBe(
        "http://localhost:8080",
      );
    });

    it("should preserve https:// prefix", () => {
      expect(normalizeBaseUrl("https://signal.example.com")).toBe(
        "https://signal.example.com",
      );
    });

    it("should add http:// prefix when missing", () => {
      expect(normalizeBaseUrl("localhost:8080")).toBe("http://localhost:8080");
    });

    it("should remove trailing slashes", () => {
      expect(normalizeBaseUrl("http://localhost:8080/")).toBe(
        "http://localhost:8080",
      );
      expect(normalizeBaseUrl("http://localhost:8080///")).toBe(
        "http://localhost:8080",
      );
    });

    it("should trim whitespace", () => {
      expect(normalizeBaseUrl("  http://localhost:8080  ")).toBe(
        "http://localhost:8080",
      );
    });

    it("should handle case-insensitive protocol", () => {
      expect(normalizeBaseUrl("HTTP://localhost:8080")).toBe(
        "HTTP://localhost:8080",
      );
      expect(normalizeBaseUrl("HTTPS://localhost:8080")).toBe(
        "HTTPS://localhost:8080",
      );
    });
  });

  describe("signalRpcRequest", () => {
    it("should make POST request with correct body", async () => {
      mockFetch.mockResolvedValueOnce({
        status: 200,
        text: () =>
          Promise.resolve(
            JSON.stringify({ jsonrpc: "2.0", result: { ok: true }, id: "1" }),
          ),
      });

      await signalRpcRequest(
        "testMethod",
        { param1: "value1" },
        { baseUrl: "http://localhost:8080" },
      );

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/api/v1/rpc");
      expect(options.method).toBe("POST");
      expect(options.headers).toEqual({ "Content-Type": "application/json" });

      const body = JSON.parse(options.body);
      expect(body.jsonrpc).toBe("2.0");
      expect(body.method).toBe("testMethod");
      expect(body.params).toEqual({ param1: "value1" });
      expect(body.id).toBeDefined();
    });

    it("should return undefined for 201 status (no content)", async () => {
      mockFetch.mockResolvedValueOnce({
        status: 201,
      });

      const result = await signalRpcRequest(
        "send",
        {},
        { baseUrl: "http://localhost:8080" },
      );
      expect(result).toBeUndefined();
    });

    it("should return result from successful response", async () => {
      mockFetch.mockResolvedValueOnce({
        status: 200,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              jsonrpc: "2.0",
              result: { version: "1.0.0" },
              id: "1",
            }),
          ),
      });

      const result = await signalRpcRequest<{ version: string }>(
        "version",
        undefined,
        { baseUrl: "http://localhost:8080" },
      );
      expect(result).toEqual({ version: "1.0.0" });
    });

    it("should throw on empty response", async () => {
      mockFetch.mockResolvedValueOnce({
        status: 200,
        text: () => Promise.resolve(""),
      });

      await expect(
        signalRpcRequest("test", undefined, {
          baseUrl: "http://localhost:8080",
        }),
      ).rejects.toThrow("Signal RPC empty response");
    });

    it("should throw on RPC error response", async () => {
      mockFetch.mockResolvedValueOnce({
        status: 200,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32600, message: "Invalid Request" },
              id: "1",
            }),
          ),
      });

      await expect(
        signalRpcRequest("test", undefined, {
          baseUrl: "http://localhost:8080",
        }),
      ).rejects.toThrow("Signal RPC -32600: Invalid Request");
    });

    it("should handle abort errors", async () => {
      // Mock fetch to throw an abort error
      const abortError = new DOMException("Aborted", "AbortError");
      mockFetch.mockRejectedValueOnce(abortError);

      await expect(
        signalRpcRequest("test", undefined, {
          baseUrl: "http://localhost:8080",
        }),
      ).rejects.toThrow("Aborted");
    });
  });

  describe("signalCheck", () => {
    it("should return ok: true for successful check", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
      });

      const result = await signalCheck("http://localhost:8080");
      expect(result.ok).toBe(true);
      expect(result.status).toBe(200);
      expect(result.error).toBeNull();
    });

    it("should return ok: false for non-ok response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 503,
      });

      const result = await signalCheck("http://localhost:8080");
      expect(result.ok).toBe(false);
      expect(result.status).toBe(503);
      expect(result.error).toBe("HTTP 503");
    });

    it("should return ok: false for network error", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      const result = await signalCheck("http://localhost:8080");
      expect(result.ok).toBe(false);
      expect(result.status).toBeNull();
      expect(result.error).toBe("Network error");
    });

    it("should make GET request to correct endpoint", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
      });

      await signalCheck("http://localhost:8080");

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8080/api/v1/check");
      expect(options.method).toBe("GET");
    });
  });

  describe("parseSignalEventData", () => {
    it("should return null for undefined data", () => {
      expect(parseSignalEventData(undefined)).toBeNull();
    });

    it("should return null for empty string", () => {
      expect(parseSignalEventData("")).toBeNull();
    });

    it("should parse valid JSON", () => {
      const data = JSON.stringify({ type: "message", text: "Hello" });
      expect(parseSignalEventData(data)).toEqual({
        type: "message",
        text: "Hello",
      });
    });

    it("should return null for invalid JSON", () => {
      expect(parseSignalEventData("not json")).toBeNull();
      expect(parseSignalEventData("{invalid}")).toBeNull();
    });

    it("should parse arrays", () => {
      const data = JSON.stringify([1, 2, 3]);
      expect(parseSignalEventData<number[]>(data)).toEqual([1, 2, 3]);
    });

    it("should parse nested objects", () => {
      const data = JSON.stringify({ outer: { inner: { value: 42 } } });
      expect(parseSignalEventData(data)).toEqual({
        outer: { inner: { value: 42 } },
      });
    });
  });

  describe("createSignalEventStream", () => {
    it("should create event stream with correct interface", () => {
      const onEvent = vi.fn();
      const stream = createSignalEventStream({
        baseUrl: "http://localhost:8080",
        onEvent,
      });

      expect(typeof stream.start).toBe("function");
      expect(typeof stream.stop).toBe("function");
      expect(typeof stream.isRunning).toBe("function");
    });

    it("should report not running initially", () => {
      const stream = createSignalEventStream({
        baseUrl: "http://localhost:8080",
        onEvent: vi.fn(),
      });

      expect(stream.isRunning()).toBe(false);
    });

    it("should report running after start", async () => {
      // Mock a streaming response that never ends
      mockFetch.mockImplementation(() => new Promise(() => {}));

      const stream = createSignalEventStream({
        baseUrl: "http://localhost:8080",
        onEvent: vi.fn(),
      });

      stream.start();
      expect(stream.isRunning()).toBe(true);

      stream.stop();
      expect(stream.isRunning()).toBe(false);
    });

    it("should not start twice", async () => {
      mockFetch.mockImplementation(() => new Promise(() => {}));

      const stream = createSignalEventStream({
        baseUrl: "http://localhost:8080",
        onEvent: vi.fn(),
      });

      stream.start();
      stream.start(); // Second call should be ignored

      expect(mockFetch).toHaveBeenCalledTimes(1);
      stream.stop();
    });

    it("should call onConnect callback", async () => {
      // Use a deferred pattern to ensure the resolve function is always available
      let resolveConnect!: () => void;
      const fetchPromise = new Promise<void>((resolve) => {
        resolveConnect = resolve;
      });

      mockFetch.mockImplementation(() => {
        return fetchPromise.then(() => ({
          ok: true,
          body: {
            getReader: () => ({
              read: () => new Promise(() => {}), // Never resolves
            }),
          },
        }));
      });

      const onConnect = vi.fn();
      const stream = createSignalEventStream({
        baseUrl: "http://localhost:8080",
        onEvent: vi.fn(),
        onConnect,
      });

      stream.start();

      // Resolve the fetch to trigger onConnect - this is now guaranteed to exist
      resolveConnect();
      await new Promise((r) => setTimeout(r, 10));
      expect(onConnect).toHaveBeenCalled();

      stream.stop();
    });

    it("should include account in URL when provided", async () => {
      mockFetch.mockImplementation(() => new Promise(() => {}));

      const stream = createSignalEventStream({
        baseUrl: "http://localhost:8080",
        account: "+1234567890",
        onEvent: vi.fn(),
      });

      stream.start();

      const [url] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain("account=%2B1234567890");

      stream.stop();
    });
  });

  describe("SSE Event Parsing Edge Cases", () => {
    it("should handle event with multiple colons", () => {
      // The field parsing should only split on the first colon
      const data = JSON.stringify({ url: "https://example.com:8080/path" });
      expect(parseSignalEventData(data)).toEqual({
        url: "https://example.com:8080/path",
      });
    });

    it("should handle unicode data", () => {
      const data = JSON.stringify({ text: "Hello 👋 World 🌍" });
      expect(parseSignalEventData(data)).toEqual({ text: "Hello 👋 World 🌍" });
    });

    it("should handle large numbers", () => {
      const data = JSON.stringify({ timestamp: 1704067200000 });
      expect(parseSignalEventData(data)).toEqual({ timestamp: 1704067200000 });
    });
  });

  describe("signalGetVersion", () => {
    it("should call RPC with correct method", async () => {
      mockFetch.mockResolvedValueOnce({
        status: 200,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              jsonrpc: "2.0",
              result: { version: "0.12.0" },
              id: "1",
            }),
          ),
      });

      const result = await signalGetVersion({
        baseUrl: "http://localhost:8080",
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.method).toBe("version");
      expect(result).toEqual({ version: "0.12.0" });
    });
  });

  describe("signalListAccounts", () => {
    it("should call RPC with correct method", async () => {
      const accounts = [
        { number: "+1234567890", uuid: "abc-123" },
        { number: "+0987654321", uuid: "def-456" },
      ];
      mockFetch.mockResolvedValueOnce({
        status: 200,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              jsonrpc: "2.0",
              result: accounts,
              id: "1",
            }),
          ),
      });

      const result = await signalListAccounts({
        baseUrl: "http://localhost:8080",
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.method).toBe("listAccounts");
      expect(result).toEqual(accounts);
    });
  });

  describe("signalListContacts", () => {
    it("should call RPC with account parameter", async () => {
      const contacts = [
        { number: "+1111111111", name: "Alice" },
        { number: "+2222222222", name: "Bob" },
      ];
      mockFetch.mockResolvedValueOnce({
        status: 200,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              jsonrpc: "2.0",
              result: contacts,
              id: "1",
            }),
          ),
      });

      const result = await signalListContacts("+1234567890", {
        baseUrl: "http://localhost:8080",
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.method).toBe("listContacts");
      expect(body.params).toEqual({ account: "+1234567890" });
      expect(result).toEqual(contacts);
    });
  });

  describe("signalListGroups", () => {
    it("should call RPC with account parameter", async () => {
      const groups = [
        { id: "group1", name: "Family" },
        { id: "group2", name: "Work" },
      ];
      mockFetch.mockResolvedValueOnce({
        status: 200,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              jsonrpc: "2.0",
              result: groups,
              id: "1",
            }),
          ),
      });

      const result = await signalListGroups("+1234567890", {
        baseUrl: "http://localhost:8080",
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.method).toBe("listGroups");
      expect(body.params).toEqual({ account: "+1234567890" });
      expect(result).toEqual(groups);
    });
  });

  describe("signalSend", () => {
    it("should call RPC with message parameters", async () => {
      mockFetch.mockResolvedValueOnce({
        status: 201,
      });

      await signalSend(
        {
          account: "+1234567890",
          recipients: ["+0987654321"],
          message: "Hello!",
        },
        { baseUrl: "http://localhost:8080" },
      );

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.method).toBe("send");
      expect(body.params).toEqual({
        account: "+1234567890",
        recipients: ["+0987654321"],
        message: "Hello!",
      });
    });

    it("should send to group", async () => {
      mockFetch.mockResolvedValueOnce({
        status: 201,
      });

      await signalSend(
        {
          account: "+1234567890",
          groupId: "group123",
          message: "Hello group!",
        },
        { baseUrl: "http://localhost:8080" },
      );

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.method).toBe("send");
      expect(body.params).toEqual({
        account: "+1234567890",
        groupId: "group123",
        message: "Hello group!",
      });
    });

    it("should send with attachments", async () => {
      mockFetch.mockResolvedValueOnce({
        status: 201,
      });

      await signalSend(
        {
          account: "+1234567890",
          recipients: ["+0987654321"],
          message: "Check this out!",
          attachments: ["/path/to/image.jpg"],
        },
        { baseUrl: "http://localhost:8080" },
      );

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.params.attachments).toEqual(["/path/to/image.jpg"]);
    });
  });

  describe("signalSendReaction", () => {
    it("should call RPC with reaction parameters", async () => {
      mockFetch.mockResolvedValueOnce({
        status: 201,
      });

      await signalSendReaction(
        {
          account: "+1234567890",
          recipient: "+0987654321",
          emoji: "👍",
          targetAuthor: "+0987654321",
          targetTimestamp: 1704067200000,
        },
        { baseUrl: "http://localhost:8080" },
      );

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.method).toBe("sendReaction");
      expect(body.params).toEqual({
        account: "+1234567890",
        recipient: "+0987654321",
        emoji: "👍",
        targetAuthor: "+0987654321",
        targetTimestamp: 1704067200000,
      });
    });

    it("should send reaction removal", async () => {
      mockFetch.mockResolvedValueOnce({
        status: 201,
      });

      await signalSendReaction(
        {
          account: "+1234567890",
          recipient: "+0987654321",
          emoji: "",
          targetAuthor: "+0987654321",
          targetTimestamp: 1704067200000,
          remove: true,
        },
        { baseUrl: "http://localhost:8080" },
      );

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.params.remove).toBe(true);
    });
  });

  describe("signalSendTyping", () => {
    it("should call RPC with typing start", async () => {
      mockFetch.mockResolvedValueOnce({
        status: 201,
      });

      await signalSendTyping(
        {
          account: "+1234567890",
          recipient: "+0987654321",
        },
        { baseUrl: "http://localhost:8080" },
      );

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.method).toBe("sendTyping");
      expect(body.params).toEqual({
        account: "+1234567890",
        recipient: "+0987654321",
      });
    });

    it("should call RPC with typing stop", async () => {
      mockFetch.mockResolvedValueOnce({
        status: 201,
      });

      await signalSendTyping(
        {
          account: "+1234567890",
          recipient: "+0987654321",
          stop: true,
        },
        { baseUrl: "http://localhost:8080" },
      );

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.params.stop).toBe(true);
    });

    it("should send to group", async () => {
      mockFetch.mockResolvedValueOnce({
        status: 201,
      });

      await signalSendTyping(
        {
          account: "+1234567890",
          groupId: "group123",
        },
        { baseUrl: "http://localhost:8080" },
      );

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.params.groupId).toBe("group123");
    });
  });

  describe("signalSendReadReceipt", () => {
    it("should call RPC with read receipt parameters", async () => {
      mockFetch.mockResolvedValueOnce({
        status: 201,
      });

      await signalSendReadReceipt(
        {
          account: "+1234567890",
          recipient: "+0987654321",
          targetTimestamp: 1704067200000,
        },
        { baseUrl: "http://localhost:8080" },
      );

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.method).toBe("sendReadReceipt");
      expect(body.params).toEqual({
        account: "+1234567890",
        recipient: "+0987654321",
        targetTimestamp: 1704067200000,
      });
    });

    it("should send receipt for different timestamps", async () => {
      mockFetch.mockResolvedValueOnce({
        status: 201,
      });

      await signalSendReadReceipt(
        {
          account: "+1234567890",
          recipient: "+0987654321",
          targetTimestamp: 1704067300000,
        },
        { baseUrl: "http://localhost:8080" },
      );

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.params.targetTimestamp).toBe(1704067300000);
    });
  });
});
