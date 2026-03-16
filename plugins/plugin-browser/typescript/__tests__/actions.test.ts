import { describe, expect, it, vi } from "vitest";
import { browserNavigateAction } from "../src/actions/navigate.js";
import { browserClickAction } from "../src/actions/click.js";
import { browserTypeAction } from "../src/actions/type.js";
import { browserSelectAction } from "../src/actions/select.js";
import { browserExtractAction } from "../src/actions/extract.js";
import { browserScreenshotAction } from "../src/actions/screenshot.js";
import { browserStateProvider } from "../src/providers/browser-state.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockClient(overrides: Record<string, unknown> = {}) {
  return {
    navigate: vi.fn(),
    click: vi.fn(),
    type: vi.fn(),
    select: vi.fn(),
    extract: vi.fn(),
    screenshot: vi.fn(),
    getState: vi.fn(),
    ...overrides,
  };
}

function createMockService(overrides: Record<string, unknown> = {}) {
  const client = createMockClient();
  return {
    getCurrentSession: vi.fn().mockResolvedValue(undefined),
    getOrCreateSession: vi.fn().mockResolvedValue(undefined),
    createSession: vi.fn().mockResolvedValue(undefined),
    getClient: vi.fn().mockReturnValue(client),
    _client: client,
    ...overrides,
  };
}

function createRuntime(service?: unknown) {
  return {
    getSetting: vi.fn().mockReturnValue("true"),
    getService: vi.fn().mockReturnValue(service),
  } as any;
}

function createMessage(text: string) {
  return {
    content: { text, source: "test" },
    userId: "user-1",
    roomId: "room-1",
  } as any;
}

const MOCK_SESSION = { id: "sess-1", createdAt: new Date() };

// ===========================================================================
// Validate – service unavailable (6 actions)
// ===========================================================================

describe("Action validate – service unavailable", () => {
  const runtimeNoService = createRuntime(undefined);

  it("BROWSER_NAVIGATE validate returns false when service unavailable", async () => {
    const msg = createMessage("Navigate to https://example.com");
    expect(await browserNavigateAction.validate(runtimeNoService, msg)).toBe(false);
  });

  it("BROWSER_CLICK validate returns false when service unavailable", async () => {
    const msg = createMessage("Click on the submit button");
    expect(await browserClickAction.validate(runtimeNoService, msg)).toBe(false);
  });

  it("BROWSER_TYPE validate returns false when service unavailable", async () => {
    const msg = createMessage('Type "hello" in the search box');
    expect(await browserTypeAction.validate(runtimeNoService, msg)).toBe(false);
  });

  it("BROWSER_SELECT validate returns false when service unavailable", async () => {
    const msg = createMessage('Select "USA" from the country dropdown');
    expect(await browserSelectAction.validate(runtimeNoService, msg)).toBe(false);
  });

  it("BROWSER_EXTRACT validate returns false when service unavailable", async () => {
    const msg = createMessage("Extract the main heading");
    expect(await browserExtractAction.validate(runtimeNoService, msg)).toBe(false);
  });

  it("BROWSER_SCREENSHOT validate returns false when service unavailable", async () => {
    const msg = createMessage("Take a screenshot");
    expect(await browserScreenshotAction.validate(runtimeNoService, msg)).toBe(false);
  });
});

// ===========================================================================
// Validate – browser not enabled
// ===========================================================================

describe("Action validate – browser not enabled", () => {
  it("BROWSER_NAVIGATE validate returns false when browser disabled", async () => {
    const runtime = {
      getSetting: vi.fn().mockReturnValue("false"),
      getService: vi.fn().mockReturnValue(createMockService()),
    } as any;
    const msg = createMessage("Navigate to https://example.com");
    expect(await browserNavigateAction.validate(runtime, msg)).toBe(false);
  });
});

// ===========================================================================
// BROWSER_NAVIGATE handler tests
// ===========================================================================

describe("BROWSER_NAVIGATE handler", () => {
  it("returns error when service is unavailable", async () => {
    const runtime = createRuntime(undefined);
    const msg = createMessage("Navigate to https://example.com");
    const callback = vi.fn();

    const result = await browserNavigateAction.handler(
      runtime, msg, undefined, undefined, callback
    );

    expect(result).toBeDefined();
    expect(result!.success).toBe(false);
    expect((result as any).data?.error).toBe("service_not_available");
  });

  it("returns error when no URL found in message", async () => {
    const mockClient = createMockClient();
    const service = createMockService({
      getCurrentSession: vi.fn().mockResolvedValue(MOCK_SESSION),
      getClient: vi.fn().mockReturnValue(mockClient),
    });
    const runtime = createRuntime(service);
    const msg = createMessage("Please navigate somewhere nice");
    const callback = vi.fn();

    const result = await browserNavigateAction.handler(
      runtime, msg, undefined, undefined, callback
    );

    expect(result).toBeDefined();
    expect(result!.success).toBe(false);
    expect((result as any).data?.error).toBe("no_url_found");
  });

  it("navigates successfully with valid URL", async () => {
    const mockClient = createMockClient({
      navigate: vi.fn().mockResolvedValue({
        success: true,
        url: "https://example.com",
        title: "Example Page",
      }),
    });
    const service = createMockService({
      getCurrentSession: vi.fn().mockResolvedValue(MOCK_SESSION),
      getClient: vi.fn().mockReturnValue(mockClient),
    });
    const runtime = createRuntime(service);
    const msg = createMessage("Navigate to https://example.com");
    const callback = vi.fn();

    const result = await browserNavigateAction.handler(
      runtime, msg, undefined, undefined, callback
    );

    expect(result).toBeDefined();
    expect(result!.success).toBe(true);
    expect((result as any).data?.url).toBe("https://example.com");
    expect((result as any).data?.title).toBe("Example Page");
    expect(callback).toHaveBeenCalled();
  });

  it("returns security error for blocked URL", async () => {
    const mockClient = createMockClient();
    const service = createMockService({
      getCurrentSession: vi.fn().mockResolvedValue(MOCK_SESSION),
      getClient: vi.fn().mockReturnValue(mockClient),
    });
    const runtime = createRuntime(service);
    const msg = createMessage("Navigate to https://malware.com/bad");
    const callback = vi.fn();

    const result = await browserNavigateAction.handler(
      runtime, msg, undefined, undefined, callback
    );

    expect(result).toBeDefined();
    expect(result!.success).toBe(false);
    expect((result as any).data?.error).toBe("security_error");
  });
});

// ===========================================================================
// BROWSER_CLICK handler tests
// ===========================================================================

describe("BROWSER_CLICK handler", () => {
  it("returns error when service is unavailable", async () => {
    const runtime = createRuntime(undefined);
    const msg = createMessage("Click on the submit button");
    const callback = vi.fn();

    const result = await browserClickAction.handler(
      runtime, msg, undefined, undefined, callback
    );

    expect(result).toBeDefined();
    expect(result!.success).toBe(false);
    expect((result as any).data?.error).toBe("service_not_available");
  });

  it("clicks element successfully", async () => {
    const mockClient = createMockClient({
      click: vi.fn().mockResolvedValue({
        type: "click",
        requestId: "req-1",
        success: true,
        data: {},
      }),
    });
    const service = createMockService({
      getOrCreateSession: vi.fn().mockResolvedValue(MOCK_SESSION),
      getClient: vi.fn().mockReturnValue(mockClient),
    });
    const runtime = createRuntime(service);
    const msg = createMessage("Click on the submit button");
    const callback = vi.fn();

    const result = await browserClickAction.handler(
      runtime, msg, undefined, undefined, callback
    );

    expect(result).toBeDefined();
    expect(result!.success).toBe(true);
    expect((result as any).data?.element).toBe("the submit button");
    expect(callback).toHaveBeenCalled();
  });

  it("throws when element not found (click fails)", async () => {
    const mockClient = createMockClient({
      click: vi.fn().mockResolvedValue({
        type: "click",
        requestId: "req-1",
        success: false,
        error: "Element not found",
      }),
    });
    const service = createMockService({
      getOrCreateSession: vi.fn().mockResolvedValue(MOCK_SESSION),
      getClient: vi.fn().mockReturnValue(mockClient),
    });
    const runtime = createRuntime(service);
    const msg = createMessage("Click on the missing button");
    const callback = vi.fn();

    await expect(
      browserClickAction.handler(runtime, msg, undefined, undefined, callback)
    ).rejects.toThrow();
  });
});

// ===========================================================================
// BROWSER_TYPE handler tests
// ===========================================================================

describe("BROWSER_TYPE handler", () => {
  it("returns error when service is unavailable", async () => {
    const runtime = createRuntime(undefined);
    const msg = createMessage('Type "hello" in the search box');
    const callback = vi.fn();

    const result = await browserTypeAction.handler(
      runtime, msg, undefined, undefined, callback
    );

    expect(result).toBeDefined();
    expect(result!.success).toBe(false);
    expect((result as any).data?.error).toBe("service_not_available");
  });

  it("throws when no text specified (missing quotes)", async () => {
    const mockClient = createMockClient();
    const service = createMockService({
      getOrCreateSession: vi.fn().mockResolvedValue(MOCK_SESSION),
      getClient: vi.fn().mockReturnValue(mockClient),
    });
    const runtime = createRuntime(service);
    const msg = createMessage("Type something in the search box");
    const callback = vi.fn();

    await expect(
      browserTypeAction.handler(runtime, msg, undefined, undefined, callback)
    ).rejects.toThrow();
  });

  it("types text successfully", async () => {
    const mockClient = createMockClient({
      type: vi.fn().mockResolvedValue({
        type: "type",
        requestId: "req-1",
        success: true,
        data: {},
      }),
    });
    const service = createMockService({
      getOrCreateSession: vi.fn().mockResolvedValue(MOCK_SESSION),
      getClient: vi.fn().mockReturnValue(mockClient),
    });
    const runtime = createRuntime(service);
    const msg = createMessage('Type "hello world" in the search box');
    const callback = vi.fn();

    const result = await browserTypeAction.handler(
      runtime, msg, undefined, undefined, callback
    );

    expect(result).toBeDefined();
    expect(result!.success).toBe(true);
    expect((result as any).data?.textTyped).toBe("hello world");
    expect(callback).toHaveBeenCalled();
  });
});

// ===========================================================================
// BROWSER_SELECT handler tests
// ===========================================================================

describe("BROWSER_SELECT handler", () => {
  it("returns error when service is unavailable", async () => {
    const runtime = createRuntime(undefined);
    const msg = createMessage('Select "USA" from the country dropdown');
    const callback = vi.fn();

    const result = await browserSelectAction.handler(
      runtime, msg, undefined, undefined, callback
    );

    expect(result).toBeDefined();
    expect(result!.success).toBe(false);
    expect((result as any).data?.error).toBe("service_not_available");
  });

  it("throws when no option specified (missing quotes)", async () => {
    const mockClient = createMockClient();
    const service = createMockService({
      getOrCreateSession: vi.fn().mockResolvedValue(MOCK_SESSION),
      getClient: vi.fn().mockReturnValue(mockClient),
    });
    const runtime = createRuntime(service);
    const msg = createMessage("Select something from the dropdown");
    const callback = vi.fn();

    await expect(
      browserSelectAction.handler(runtime, msg, undefined, undefined, callback)
    ).rejects.toThrow();
  });

  it("selects option successfully", async () => {
    const mockClient = createMockClient({
      select: vi.fn().mockResolvedValue({
        type: "select",
        requestId: "req-1",
        success: true,
        data: {},
      }),
    });
    const service = createMockService({
      getOrCreateSession: vi.fn().mockResolvedValue(MOCK_SESSION),
      getClient: vi.fn().mockReturnValue(mockClient),
    });
    const runtime = createRuntime(service);
    const msg = createMessage('Select "United States" from the country dropdown');
    const callback = vi.fn();

    const result = await browserSelectAction.handler(
      runtime, msg, undefined, undefined, callback
    );

    expect(result).toBeDefined();
    expect(result!.success).toBe(true);
    expect((result as any).data?.option).toBe("United States");
    expect(callback).toHaveBeenCalled();
  });
});

// ===========================================================================
// BROWSER_EXTRACT handler tests
// ===========================================================================

describe("BROWSER_EXTRACT handler", () => {
  it("returns error when service is unavailable", async () => {
    const runtime = createRuntime(undefined);
    const msg = createMessage("Extract the main heading");
    const callback = vi.fn();

    const result = await browserExtractAction.handler(
      runtime, msg, undefined, undefined, callback
    );

    expect(result).toBeDefined();
    expect(result!.success).toBe(false);
    expect((result as any).data?.error).toBe("service_not_available");
  });

  it("extracts data successfully", async () => {
    const mockClient = createMockClient({
      extract: vi.fn().mockResolvedValue({
        type: "extract",
        requestId: "req-1",
        success: true,
        data: { found: true, data: "Welcome to Our Website" },
      }),
    });
    const service = createMockService({
      getOrCreateSession: vi.fn().mockResolvedValue(MOCK_SESSION),
      getClient: vi.fn().mockReturnValue(mockClient),
    });
    const runtime = createRuntime(service);
    const msg = createMessage("Extract the main heading from the page");
    const callback = vi.fn();

    const result = await browserExtractAction.handler(
      runtime, msg, undefined, undefined, callback
    );

    expect(result).toBeDefined();
    expect(result!.success).toBe(true);
    expect((result as any).data?.found).toBe(true);
    expect((result as any).data?.extractedData).toBe("Welcome to Our Website");
    expect(callback).toHaveBeenCalled();
  });

  it("handles empty extraction result", async () => {
    const mockClient = createMockClient({
      extract: vi.fn().mockResolvedValue({
        type: "extract",
        requestId: "req-1",
        success: true,
        data: { found: false },
      }),
    });
    const service = createMockService({
      getOrCreateSession: vi.fn().mockResolvedValue(MOCK_SESSION),
      getClient: vi.fn().mockReturnValue(mockClient),
    });
    const runtime = createRuntime(service);
    const msg = createMessage("Extract the sidebar content from the page");
    const callback = vi.fn();

    const result = await browserExtractAction.handler(
      runtime, msg, undefined, undefined, callback
    );

    expect(result).toBeDefined();
    expect(result!.success).toBe(true);
    expect((result as any).data?.found).toBe(false);
  });
});

// ===========================================================================
// BROWSER_SCREENSHOT handler tests
// ===========================================================================

describe("BROWSER_SCREENSHOT handler", () => {
  it("returns error when service is unavailable", async () => {
    const runtime = createRuntime(undefined);
    const msg = createMessage("Take a screenshot");
    const callback = vi.fn();

    const result = await browserScreenshotAction.handler(
      runtime, msg, undefined, undefined, callback
    );

    expect(result).toBeDefined();
    expect(result!.success).toBe(false);
    expect((result as any).data?.error).toBe("service_not_available");
  });

  it("takes screenshot successfully", async () => {
    const mockClient = createMockClient({
      screenshot: vi.fn().mockResolvedValue({
        type: "screenshot",
        requestId: "req-1",
        success: true,
        data: {
          url: "https://example.com",
          title: "Example Page",
          screenshot: "base64data",
          mimeType: "image/png",
        },
      }),
    });
    const service = createMockService({
      getOrCreateSession: vi.fn().mockResolvedValue(MOCK_SESSION),
      getClient: vi.fn().mockReturnValue(mockClient),
    });
    const runtime = createRuntime(service);
    const msg = createMessage("Take a screenshot of the page");
    const callback = vi.fn();

    const result = await browserScreenshotAction.handler(
      runtime, msg, undefined, undefined, callback
    );

    expect(result).toBeDefined();
    expect(result!.success).toBe(true);
    expect((result as any).data?.url).toBe("https://example.com");
    expect((result as any).data?.title).toBe("Example Page");
    expect(callback).toHaveBeenCalled();
  });

  it("throws when screenshot fails", async () => {
    const mockClient = createMockClient({
      screenshot: vi.fn().mockResolvedValue({
        type: "screenshot",
        requestId: "req-1",
        success: false,
        error: "Screenshot failed",
      }),
    });
    const service = createMockService({
      getOrCreateSession: vi.fn().mockResolvedValue(MOCK_SESSION),
      getClient: vi.fn().mockReturnValue(mockClient),
    });
    const runtime = createRuntime(service);
    const msg = createMessage("Take a screenshot");
    const callback = vi.fn();

    await expect(
      browserScreenshotAction.handler(runtime, msg, undefined, undefined, callback)
    ).rejects.toThrow();
  });
});

// ===========================================================================
// BROWSER_STATE provider tests
// ===========================================================================

describe("BROWSER_STATE provider", () => {
  it("returns state when service and session are available", async () => {
    const mockClient = createMockClient({
      getState: vi.fn().mockResolvedValue({
        url: "https://example.com",
        title: "Example Page",
        sessionId: "sess-1",
        createdAt: new Date(),
      }),
    });
    const service = createMockService({
      getCurrentSession: vi.fn().mockResolvedValue(MOCK_SESSION),
      getClient: vi.fn().mockReturnValue(mockClient),
    });
    const runtime = createRuntime(service);
    const msg = createMessage("check state");

    const result = await browserStateProvider.get(runtime, msg);

    expect(result).toBeDefined();
    expect(result.text).toContain("Example Page");
    expect(result.text).toContain("https://example.com");
    expect(result.values?.hasSession).toBe(true);
    expect(result.values?.url).toBe("https://example.com");
  });

  it("returns no-session when service is unavailable", async () => {
    const runtime = createRuntime(undefined);
    const msg = createMessage("check state");

    const result = await browserStateProvider.get(runtime, msg);

    expect(result).toBeDefined();
    expect(result.text).toBe("No active browser session");
    expect(result.values?.hasSession).toBe(false);
  });

  it("returns error state when getState throws", async () => {
    const mockClient = createMockClient({
      getState: vi.fn().mockRejectedValue(new Error("Connection lost")),
    });
    const service = createMockService({
      getCurrentSession: vi.fn().mockResolvedValue(MOCK_SESSION),
      getClient: vi.fn().mockReturnValue(mockClient),
    });
    const runtime = createRuntime(service);
    const msg = createMessage("check state");

    const result = await browserStateProvider.get(runtime, msg);

    expect(result).toBeDefined();
    expect(result.text).toBe("Error getting browser state");
    expect(result.values?.error).toBe(true);
  });
});
