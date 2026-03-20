import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ADAPTER_NAME_TO_TAB,
  CodingAgentSettingsSection,
  _clearSettingsCache,
} from "./CodingAgentSettingsSection";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockGetConfig = vi.fn();
const mockFetchModels = vi.fn();

vi.mock("../api", () => ({
  client: {
    getConfig: (...args: unknown[]) => mockGetConfig(...args),
    fetchModels: (...args: unknown[]) => mockFetchModels(...args),
  },
}));

vi.mock("../state", () => ({
  useApp: () => ({ t: (key: string) => key }),
}));

vi.mock("../hooks", () => ({
  useTimeout: () => ({ setTimeout: globalThis.setTimeout }),
}));

vi.mock("./ConfigSaveFooter", () => ({
  ConfigSaveFooter: () => null,
}));

vi.mock("@elizaos/ui", () => ({
  Button: ({
    children,
    ...props
  }: { children: React.ReactNode; [k: string]: unknown }) => (
    <button {...(props as React.ButtonHTMLAttributes<HTMLButtonElement>)}>
      {children}
    </button>
  ),
}));

// Stub global fetch for the preflight endpoint
const mockFetch = vi.fn();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Default API stubs that resolve successfully with minimal data. */
function stubSuccessfulApis() {
  mockGetConfig.mockResolvedValue({ env: {} });
  mockFetchModels.mockResolvedValue({ models: [] });
  mockFetch.mockResolvedValue({
    ok: true,
    json: () =>
      Promise.resolve([
        { adapter: "claude code", installed: true },
        { adapter: "aider", installed: true },
      ]),
  });
}

/** Flush all microtasks / pending promises so useEffect callbacks complete. */
async function flushPromises() {
  await act(async () => {
    // Let pending promises resolve
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
  });
}

/**
 * Recursively search the rendered tree for a node whose props or children
 * match a predicate. Returns true if found.
 */
function treeContainsText(
  node: ReactTestRenderer,
  text: string,
): boolean {
  const json = node.toJSON();
  return jsonContainsText(json, text);
}

function jsonContainsText(
  node: unknown,
  text: string,
): boolean {
  if (node === null || node === undefined) return false;
  if (typeof node === "string") return node.includes(text);
  if (Array.isArray(node)) return node.some((n) => jsonContainsText(n, text));
  if (typeof node === "object" && node !== null) {
    const obj = node as { children?: unknown };
    if (obj.children) return jsonContainsText(obj.children, text);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Tests — ADAPTER_NAME_TO_TAB (existing)
// ---------------------------------------------------------------------------

describe("ADAPTER_NAME_TO_TAB", () => {
  it("maps full adapter names from preflight API to tab keys", () => {
    expect(ADAPTER_NAME_TO_TAB["claude code"]).toBe("claude");
    expect(ADAPTER_NAME_TO_TAB["google gemini"]).toBe("gemini");
    expect(ADAPTER_NAME_TO_TAB["openai codex"]).toBe("codex");
    expect(ADAPTER_NAME_TO_TAB["aider"]).toBe("aider");
  });

  it("maps short adapter names for backwards compatibility", () => {
    expect(ADAPTER_NAME_TO_TAB["claude"]).toBe("claude");
    expect(ADAPTER_NAME_TO_TAB["gemini"]).toBe("gemini");
    expect(ADAPTER_NAME_TO_TAB["codex"]).toBe("codex");
  });

  it("returns undefined for unknown adapter names", () => {
    expect(ADAPTER_NAME_TO_TAB["unknown-agent"]).toBeUndefined();
    expect(ADAPTER_NAME_TO_TAB[""]).toBeUndefined();
  });

  it("handles the lowercase normalization used at the call site", () => {
    // The call site does `item.adapter?.toLowerCase()` before lookup,
    // so the map only needs lowercase keys
    const simulatePreflight = (adapterName: string) =>
      ADAPTER_NAME_TO_TAB[adapterName.toLowerCase()];

    expect(simulatePreflight("Claude Code")).toBe("claude");
    expect(simulatePreflight("Google Gemini")).toBe("gemini");
    expect(simulatePreflight("OpenAI Codex")).toBe("codex");
    expect(simulatePreflight("Aider")).toBe("aider");
  });
});

// ---------------------------------------------------------------------------
// Tests — Loading / caching behavior
// ---------------------------------------------------------------------------

describe("CodingAgentSettingsSection loading and cache", () => {
  beforeEach(() => {
    _clearSettingsCache();
    vi.restoreAllMocks();
    // Replace global fetch with our mock
    vi.stubGlobal("fetch", mockFetch);
    stubSuccessfulApis();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows loading text on first mount before data loads", () => {
    // Make APIs hang so loading state is captured
    mockGetConfig.mockReturnValue(new Promise(() => {}));

    let renderer: ReactTestRenderer;
    act(() => {
      renderer = create(<CodingAgentSettingsSection />);
    });

    // Should show the loading i18n key
    expect(
      treeContainsText(
        renderer!,
        "codingagentsettingssection.LoadingCodingAgent",
      ),
    ).toBe(true);
  });

  it("shows content after data loads", async () => {
    let renderer: ReactTestRenderer;
    act(() => {
      renderer = create(<CodingAgentSettingsSection />);
    });

    await flushPromises();

    // Loading text should be gone; settings content should be present.
    // The settings section renders i18n keys like "AgentSelectionStra"
    expect(
      treeContainsText(
        renderer!,
        "codingagentsettingssection.LoadingCodingAgent",
      ),
    ).toBe(false);
    expect(
      treeContainsText(
        renderer!,
        "codingagentsettingssection.AgentSelectionStra",
      ),
    ).toBe(true);
  });

  it("does NOT show loading skeleton on re-mount when cache exists", async () => {
    // First mount — populates the cache
    let renderer: ReactTestRenderer;
    act(() => {
      renderer = create(<CodingAgentSettingsSection />);
    });
    await flushPromises();

    // Unmount
    act(() => {
      renderer!.unmount();
    });

    // Re-mount — cache should prevent loading skeleton
    let renderer2: ReactTestRenderer;
    act(() => {
      renderer2 = create(<CodingAgentSettingsSection />);
    });

    // Immediately after mount (before background fetch resolves),
    // should NOT show loading — should show cached content instead.
    expect(
      treeContainsText(
        renderer2!,
        "codingagentsettingssection.LoadingCodingAgent",
      ),
    ).toBe(false);
    expect(
      treeContainsText(
        renderer2!,
        "codingagentsettingssection.AgentSelectionStra",
      ),
    ).toBe(true);

    // Clean up
    await flushPromises();
  });

  it("still fetches fresh data in background on re-mount", async () => {
    // First mount
    let renderer: ReactTestRenderer;
    act(() => {
      renderer = create(<CodingAgentSettingsSection />);
    });
    await flushPromises();

    const callCountAfterFirst = mockGetConfig.mock.calls.length;

    // Unmount and re-mount
    act(() => {
      renderer!.unmount();
    });

    act(() => {
      renderer = create(<CodingAgentSettingsSection />);
    });
    await flushPromises();

    // getConfig should have been called again for the background refresh
    expect(mockGetConfig.mock.calls.length).toBeGreaterThan(
      callCountAfterFirst,
    );
  });

  it("_clearSettingsCache resets the cache so next mount shows loading", async () => {
    // First mount — populates cache
    let renderer: ReactTestRenderer;
    act(() => {
      renderer = create(<CodingAgentSettingsSection />);
    });
    await flushPromises();
    act(() => {
      renderer!.unmount();
    });

    // Clear the cache
    _clearSettingsCache();

    // Make APIs hang so we can observe loading state
    mockGetConfig.mockReturnValue(new Promise(() => {}));

    let renderer2: ReactTestRenderer;
    act(() => {
      renderer2 = create(<CodingAgentSettingsSection />);
    });

    // Should show loading again since cache was cleared
    expect(
      treeContainsText(
        renderer2!,
        "codingagentsettingssection.LoadingCodingAgent",
      ),
    ).toBe(true);
  });
});
