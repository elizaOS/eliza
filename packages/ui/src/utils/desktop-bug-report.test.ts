/**
 * Verifies the desktop bug-report helpers keep one exact Electrobun bridge
 * contract: outside the desktop runtime every helper degrades to a null or
 * void result without touching the preload RPC, and inside it each helper
 * dispatches its canonical rpc method with verbatim params and propagates the
 * native receipt (including a null receipt) unchanged. The diagnostics
 * formatter is pinned as a full ordered sheet covering every fallback branch.
 * Deterministic unit harness: the preload seam is a plain object installed on
 * `globalThis.window`, matching how the real Electrobun preload injects it.
 */
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  createDesktopBugReportBundle,
  type DesktopBugReportDiagnostics,
  formatDesktopBugReportDiagnostics,
  loadDesktopBugReportDiagnostics,
  openDesktopLogsFolder,
} from "./desktop-bug-report";

interface DesktopBridgeTestWindow {
  __electrobunWindowId?: number;
  __electrobunWebviewId?: number;
  __ELIZA_ELECTROBUN_RPC__?: {
    request: Record<string, (params?: unknown) => Promise<unknown>>;
    onMessage?: (
      messageName: string,
      listener: (payload: unknown) => void,
    ) => void;
    offMessage?: (
      messageName: string,
      listener: (payload: unknown) => void,
    ) => void;
  };
}

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const desktopWindow = {} as DesktopBridgeTestWindow;

beforeEach(() => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: desktopWindow,
  });
});

afterEach(() => {
  delete desktopWindow.__ELIZA_ELECTROBUN_RPC__;
  delete desktopWindow.__electrobunWindowId;
  delete desktopWindow.__electrobunWebviewId;
});

afterAll(() => {
  if (originalWindow) {
    Object.defineProperty(globalThis, "window", originalWindow);
  } else {
    Reflect.deleteProperty(globalThis, "window");
  }
});

function installElectrobunRpc(
  handlers: Record<string, (params?: unknown) => Promise<unknown>>,
): void {
  desktopWindow.__electrobunWebviewId = 7;
  desktopWindow.__ELIZA_ELECTROBUN_RPC__ = {
    request: handlers,
    onMessage: vi.fn(),
    offMessage: vi.fn(),
  };
}

function makeDiagnostics(
  overrides: Partial<DesktopBugReportDiagnostics> = {},
): DesktopBugReportDiagnostics {
  return {
    state: "running",
    phase: "ready",
    updatedAt: "2026-08-24T00:00:00Z",
    lastError: null,
    agentName: "Eliza",
    port: 3000,
    startedAt: 1700000000000,
    platform: "darwin",
    arch: "arm64",
    configDir: "/Users/user/.eliza",
    logPath: "/Users/user/.eliza/logs/agent.log",
    statusPath: "/Users/user/.eliza/status.json",
    logTail: "All systems go",
    ...overrides,
  };
}

describe("loadDesktopBugReportDiagnostics", () => {
  it("returns null when there is no window at all", async () => {
    Reflect.deleteProperty(globalThis, "window");

    await expect(loadDesktopBugReportDiagnostics()).resolves.toBeNull();
  });

  it("returns null on a plain web window without electrobun markers", async () => {
    await expect(loadDesktopBugReportDiagnostics()).resolves.toBeNull();
  });

  it("loads startup diagnostics through desktopGetStartupDiagnostics in the desktop runtime", async () => {
    const diagnostics = makeDiagnostics({ state: "starting", phase: "boot" });
    const handler = vi.fn(async () => diagnostics);
    installElectrobunRpc({ desktopGetStartupDiagnostics: handler });

    const result = await loadDesktopBugReportDiagnostics();

    expect(result).toEqual(diagnostics);
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(undefined);
  });

  it("resolves null when only a window id marks the runtime and no RPC exists", async () => {
    desktopWindow.__electrobunWindowId = 3;

    await expect(loadDesktopBugReportDiagnostics()).resolves.toBeNull();
  });

  it("resolves null when the diagnostics handler is not registered yet", async () => {
    installElectrobunRpc({});

    await expect(loadDesktopBugReportDiagnostics()).resolves.toBeNull();
  });
});

describe("openDesktopLogsFolder", () => {
  it("never reaches the logs-folder handler outside the electrobun runtime", async () => {
    const handler = vi.fn(async () => "opened");
    // A populated request map alone does not mark an electrobun runtime:
    // without callable onMessage/offMessage the guard must still block.
    desktopWindow.__ELIZA_ELECTROBUN_RPC__ = {
      request: { desktopOpenLogsFolder: handler },
    };

    await expect(openDesktopLogsFolder()).resolves.toBeUndefined();
    expect(handler).not.toHaveBeenCalled();
  });

  it("opens the logs folder through desktopOpenLogsFolder and resolves void", async () => {
    const handler = vi.fn(async () => ({ ok: true }));
    installElectrobunRpc({ desktopOpenLogsFolder: handler });

    await expect(openDesktopLogsFolder()).resolves.toBeUndefined();
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(undefined);
  });

  it("resolves undefined instead of throwing when the handler is missing", async () => {
    installElectrobunRpc({});

    await expect(openDesktopLogsFolder()).resolves.toBeUndefined();
  });
});

describe("createDesktopBugReportBundle", () => {
  it("returns null without touching the bridge outside the electrobun runtime", async () => {
    const handler = vi.fn(async () => null);
    desktopWindow.__ELIZA_ELECTROBUN_RPC__ = {
      request: { desktopCreateBugReportBundle: handler },
    };

    await expect(
      createDesktopBugReportBundle({
        reportMarkdown: "# Report",
        reportJson: { ok: true },
      }),
    ).resolves.toBeNull();
    expect(handler).not.toHaveBeenCalled();
  });

  it("passes the report payloads through to desktopCreateBugReportBundle verbatim", async () => {
    const bundle = {
      directory: "/Users/user/.eliza/bug-reports/2026-08-24T00-00-00",
      reportMarkdownPath:
        "/Users/user/.eliza/bug-reports/2026-08-24T00-00-00/report.md",
      reportJsonPath:
        "/Users/user/.eliza/bug-reports/2026-08-24T00-00-00/report.json",
      startupLogPath: "/Users/user/.eliza/logs/agent.log",
      startupStatusPath: "/Users/user/.eliza/status.json",
    };
    const reportJson = { appVersion: "1.9.0", notes: "crash on launch" };
    const options = {
      reportMarkdown: "# Report\nbody",
      reportJson,
      prefix: "eliza-bug",
    };
    let receivedParams: unknown;
    const handler = vi.fn(async (params?: unknown) => {
      receivedParams = params;
      return bundle;
    });
    installElectrobunRpc({ desktopCreateBugReportBundle: handler });

    const result = await createDesktopBugReportBundle(options);

    expect(result).toEqual(bundle);
    expect(handler).toHaveBeenCalledOnce();
    expect(receivedParams).toEqual(options);
  });

  it("does not add a prefix key when the caller omits it, and propagates a null receipt", async () => {
    let receivedParams: unknown;
    const handler = vi.fn(async (params?: unknown) => {
      receivedParams = params;
      return null;
    });
    installElectrobunRpc({ desktopCreateBugReportBundle: handler });

    await expect(
      createDesktopBugReportBundle({
        reportMarkdown: "# Report",
        reportJson: {},
      }),
    ).resolves.toBeNull();
    expect(receivedParams).toEqual({
      reportMarkdown: "# Report",
      reportJson: {},
    });
    expect(Object.keys(receivedParams as Record<string, unknown>)).toEqual([
      "reportMarkdown",
      "reportJson",
    ]);
  });

  it("resolves null when the bundle handler is not registered", async () => {
    installElectrobunRpc({});

    await expect(
      createDesktopBugReportBundle({
        reportMarkdown: "# Report",
        reportJson: {},
      }),
    ).resolves.toBeNull();
  });
});

describe("formatDesktopBugReportDiagnostics", () => {
  it("renders the complete diagnostics sheet in canonical field order", () => {
    const formatted = formatDesktopBugReportDiagnostics(
      makeDiagnostics({
        appVersion: "1.9.0",
        appRuntime: "electrobun",
        packaged: true,
        locale: "en-US",
      }),
    );

    expect(formatted).toBe(
      [
        "App Version: 1.9.0",
        "Runtime: electrobun",
        "Packaged: yes",
        "Platform: darwin arm64",
        "Locale: en-US",
        "Startup State: running",
        "Startup Phase: ready",
        "Last Error: none",
        "Agent Name: Eliza",
        "Port: 3000",
        "Updated At: 2026-08-24T00:00:00Z",
        "Log Path: /Users/user/.eliza/logs/agent.log",
        "Status Path: /Users/user/.eliza/status.json",
      ].join("\n"),
    );
  });

  it("falls back to unknown for absent version, runtime, locale, agent name and port fields", () => {
    const formatted = formatDesktopBugReportDiagnostics(
      makeDiagnostics({ agentName: null, port: null }),
    );

    expect(formatted).toContain("App Version: unknown");
    expect(formatted).toContain("Runtime: unknown");
    expect(formatted).toContain("Packaged: unknown");
    expect(formatted).toContain("Locale: unknown");
    expect(formatted).toContain("Agent Name: unknown");
    expect(formatted).toContain("Port: unknown");
  });

  it("reports packaged as no when explicitly false, not unknown", () => {
    const formatted = formatDesktopBugReportDiagnostics(
      makeDiagnostics({ packaged: false }),
    );

    expect(formatted).toContain("Packaged: no");
  });

  it("echoes the recorded last error instead of none", () => {
    const formatted = formatDesktopBugReportDiagnostics(
      makeDiagnostics({ lastError: "Port already in use" }),
    );

    expect(formatted).toContain("Last Error: Port already in use");
  });

  it("renders an errored startup snapshot with its state, phase and null fields degraded", () => {
    const formatted = formatDesktopBugReportDiagnostics(
      makeDiagnostics({
        state: "error",
        phase: "backend-crashed",
        lastError: "EADDRINUSE",
        agentName: null,
        port: null,
        packaged: false,
      }),
    );

    expect(formatted).toContain("Startup State: error");
    expect(formatted).toContain("Startup Phase: backend-crashed");
    expect(formatted).toContain("Last Error: EADDRINUSE");
    expect(formatted).toContain("Packaged: no");
    expect(formatted).toContain("Agent Name: unknown");
    expect(formatted).toContain("Port: unknown");
  });
});
