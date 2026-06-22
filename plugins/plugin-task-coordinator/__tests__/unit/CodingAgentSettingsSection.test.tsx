// @vitest-environment jsdom
//
// Behavioral coverage for CodingAgentSettingsSection (the task-coordinator
// Coding-Agents settings page, src/CodingAgentSettingsSection.tsx) and its
// sub-sections (AgentTabsSection / LlmProviderSection / ModelConfigSection /
// GlobalPrefsSection / GitHubConnectionCard). Before this file the section had
// ZERO in-plugin coverage — the only regression net was the two co-located
// boundary-helper tests under src/api/. This closes that gap by asserting the
// real wiring a user touches every time they configure a coding agent:
//
//   * mount loads config + preflight + models and leaves the loading state;
//   * one tab per installed framework, with the prefs-driven default tab
//     rendered active (data-variant="default");
//   * switching tabs persists ELIZA_DEFAULT_AGENT_TYPE through the debounced
//     auto-save -> client.updateConfig;
//   * model selection persists through the prefs client to ENV_PREFIX-keyed
//     env (powerful + fast), with fetched models preferred and FALLBACK_MODELS
//     used on fetch failure;
//   * approval-preset + selection-strategy persist;
//   * the auto-save "no write without interaction" guard (autoSaveArmedRef)
//     and the "_"-prefixed synthetic-key strip both hold;
//   * a rejected updateConfig surfaces a role="alert" banner;
//   * the no-installed-CLIs branch renders the install list (no tabs);
//   * needs-auth banner POSTs /api/coding-agents/auth/{agent};
//   * GitHub card connect / disconnect / generate-link / error states.
//
// Plus supplementary edge cases for the auth-sanitize + preflight-normalize
// boundary helpers that the existing co-located tests do NOT cover
// (protocol-relative URL, uppercase scheme, non-string url, whitespace status,
// empty status, full round-trip, array input).
//
// @elizaos/ui is mocked entirely (the real Select is Radix, which misbehaves in
// jsdom) — Select -> native <select>, Button -> <button>, etc. — mirroring the
// sibling CodingAgentTasksPanel.test.tsx pattern. global.fetch is stubbed for
// /api/coding-agents/preflight + /api/coding-agents/auth/{agent}; the GitHub
// card uses client.fetch (a separate spy).

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sanitizeAuthResult } from "../../src/api/coding-agents-auth-sanitize.js";
import { normalizePreflightAuth } from "../../src/api/coding-agents-preflight-normalize.js";

// --- @elizaos/ui spies -----------------------------------------------------

const getConfig = vi.fn();
const updateConfig = vi.fn();
const fetchModels = vi.fn();
const githubFetch = vi.fn();
const openExternalUrl = vi.fn();

// Shared app value so useApp / useAppSelector / useAppSelectorShallow all read
// the same fields. `t` renders vars.defaultValue and interpolates {{var}} —
// the same contract the real i18n catalog implements — so when a key has no
// defaultValue (e.g. the Loading placeholder) the raw key is rendered, which
// the tests assert against verbatim.
const mockAppValue = vi.hoisted(() => ({
  t: (key: string, vars?: Record<string, unknown>) => {
    const template = String(vars?.defaultValue ?? key);
    return template.replace(/\{\{(\w+)\}\}/g, (_m: string, name: string) =>
      vars && name in vars ? String(vars[name]) : `{{${name}}}`,
    );
  },
  elizaCloudConnected: true,
}));

vi.mock("@elizaos/ui", () => {
  type AnyProps = Record<string, unknown> & { children?: ReactNode };
  const passthrough = ({ children }: AnyProps) => <>{children}</>;
  return {
    client: {
      getConfig: (...a: unknown[]) => getConfig(...a),
      updateConfig: (...a: unknown[]) => updateConfig(...a),
      fetchModels: (...a: unknown[]) => fetchModels(...a),
      fetch: (...a: unknown[]) => githubFetch(...a),
    },
    openExternalUrl: (...a: unknown[]) => openExternalUrl(...a),
    useApp: () => mockAppValue,
    useAppSelector: (sel: (s: Record<string, unknown>) => unknown) =>
      sel(mockAppValue),
    useAppSelectorShallow: (sel: (s: Record<string, unknown>) => unknown) =>
      sel(mockAppValue),
    Button: ({
      children,
      onClick,
      disabled,
      "aria-label": ariaLabel,
      "aria-pressed": ariaPressed,
      title,
      variant,
    }: {
      children?: ReactNode;
      onClick?: () => void;
      disabled?: boolean;
      "aria-label"?: string;
      "aria-pressed"?: boolean;
      title?: string;
      variant?: string;
    }) => (
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-pressed={ariaPressed}
        title={title}
        data-variant={variant}
      >
        {children}
      </button>
    ),
    // Radix Select stand-ins: a native <select> drives onValueChange through
    // its change event, SelectItem -> <option>. The trigger/value/content
    // wrappers pass children through so the <option>s end up inside <select>.
    Select: ({
      value,
      onValueChange,
      children,
    }: {
      value?: string;
      onValueChange?: (v: string) => void;
      children?: ReactNode;
    }) => (
      <select value={value} onChange={(e) => onValueChange?.(e.target.value)}>
        {children}
      </select>
    ),
    SelectContent: passthrough,
    SelectItem: ({
      value,
      children,
    }: {
      value: string;
      children?: ReactNode;
    }) => <option value={value}>{children}</option>,
    SelectTrigger: passthrough,
    SelectValue: () => null,
    SettingsControls: {
      Input: (p: AnyProps) => <input {...(p as object)} />,
      Textarea: (p: AnyProps) => <textarea {...(p as object)} />,
      SelectTrigger: passthrough,
      SegmentedGroup: ({ children }: AnyProps) => (
        <fieldset>{children}</fieldset>
      ),
      MutedText: ({ children }: AnyProps) => <span>{children}</span>,
      Field: ({ children }: AnyProps) => <div>{children}</div>,
      FieldLabel: ({ children }: AnyProps) => <span>{children}</span>,
      FieldDescription: ({ children }: AnyProps) => <p>{children}</p>,
    },
  };
});

import { CodingAgentSettingsSection } from "../../src/CodingAgentSettingsSection";

// --- preflight + global.fetch helpers --------------------------------------

type PreflightRow = {
  adapter: string;
  installed: boolean;
  auth?: { status: string };
  installCommand?: string;
  docsUrl?: string;
};

const ALL_INSTALLED: PreflightRow[] = [
  { adapter: "eliza", installed: true, auth: { status: "authenticated" } },
  { adapter: "pi-agent", installed: true, auth: { status: "authenticated" } },
  { adapter: "opencode", installed: true, auth: { status: "authenticated" } },
  {
    adapter: "claude code",
    installed: true,
    auth: { status: "authenticated" },
  },
  {
    adapter: "openai codex",
    installed: true,
    auth: { status: "authenticated" },
  },
];

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as unknown as Response;
}

// Route global.fetch by URL: preflight -> the configured rows, auth POST ->
// a launched result. Auth POST calls are recorded on `authFetchCalls`.
let preflightRows: PreflightRow[] = ALL_INSTALLED;
let authFetchCalls: Array<{ url: string; init?: RequestInit }> = [];

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith("/api/coding-agents/preflight")) {
        return jsonResponse(preflightRows);
      }
      if (url.startsWith("/api/coding-agents/auth/")) {
        authFetchCalls.push({ url, init });
        return jsonResponse({ launched: true, instructions: "Open the CLI." });
      }
      return jsonResponse(null, false);
    }),
  );
}

// --- config / models fixtures ----------------------------------------------

type EnvConfig = {
  env?: Record<string, string>;
  cloud?: Record<string, string>;
};

function setConfig(cfg: EnvConfig) {
  getConfig.mockResolvedValue({ env: cfg.env ?? {}, cloud: cfg.cloud ?? {} });
}

beforeEach(() => {
  getConfig.mockReset();
  updateConfig.mockReset().mockResolvedValue({});
  fetchModels
    .mockReset()
    .mockResolvedValue({ provider: "anthropic", models: [] });
  githubFetch.mockReset().mockResolvedValue({ connected: false });
  openExternalUrl.mockReset();
  preflightRows = ALL_INSTALLED;
  authFetchCalls = [];
  installFetch();
  setConfig({ env: {} });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// Find a <select> on screen by the value of one of its <option>s. Multiple
// selects coexist (powerful/fast model, selection-strategy, account-pool,
// approval-preset, scratch-retention) so disambiguate by option value, never
// by index — order/visibility can shift across renders.
function selectWithOption(optionValue: string): HTMLSelectElement {
  const selects = Array.from(
    document.querySelectorAll("select"),
  ) as HTMLSelectElement[];
  const match = selects.find((s) =>
    Array.from(s.options).some((o) => o.value === optionValue),
  );
  if (!match) {
    throw new Error(
      `No <select> found containing option value "${optionValue}"`,
    );
  }
  return match;
}

describe("CodingAgentSettingsSection", () => {
  it("shows the loading placeholder before config resolves, then leaves it", async () => {
    setConfig({ env: {} });
    render(<CodingAgentSettingsSection />);
    // No defaultValue on the loading key -> raw key text is rendered.
    expect(
      screen.getByText("codingagentsettingssection.LoadingCodingAgent"),
    ).toBeTruthy();
    await screen.findByRole("button", { name: /elizaOS/ });
    expect(
      screen.queryByText("codingagentsettingssection.LoadingCodingAgent"),
    ).toBeNull();
  });

  it("renders one tab per installed framework", async () => {
    render(<CodingAgentSettingsSection />);
    await screen.findByRole("button", { name: /elizaOS/ });
    // aria-label is `${AGENT_LABELS[agent]} ${statusLabel}` — match the label.
    for (const label of [
      "elizaOS",
      "Pi Agent",
      "OpenCode",
      "Claude",
      "Codex",
    ]) {
      expect(
        screen.getByRole("button", { name: new RegExp(`^${label}\\s`) }),
      ).toBeTruthy();
    }
  });

  it("marks the prefs-default agent tab active and the rest ghost", async () => {
    setConfig({ env: { ELIZA_DEFAULT_AGENT_TYPE: "claude" } });
    render(<CodingAgentSettingsSection />);
    const claudeTab = await screen.findByRole("button", { name: /^Claude\s/ });
    expect(claudeTab.getAttribute("data-variant")).toBe("default");
    const codexTab = screen.getByRole("button", { name: /^Codex\s/ });
    expect(codexTab.getAttribute("data-variant")).toBe("ghost");
  });

  it("persists the active tab through debounced auto-save when switching", async () => {
    setConfig({ env: { ELIZA_DEFAULT_AGENT_TYPE: "claude" } });
    render(<CodingAgentSettingsSection />);
    const codexTab = await screen.findByRole("button", { name: /^Codex\s/ });
    fireEvent.click(codexTab);
    // The clicked tab becomes active immediately.
    expect(
      screen
        .getByRole("button", { name: /^Codex\s/ })
        .getAttribute("data-variant"),
    ).toBe("default");
    // The debounced (400ms) auto-save persists ELIZA_DEFAULT_AGENT_TYPE=codex.
    await waitFor(
      () => {
        expect(updateConfig).toHaveBeenCalled();
        const last = updateConfig.mock.calls.at(-1)?.[0] as {
          env: Record<string, string>;
        };
        expect(last.env.ELIZA_DEFAULT_AGENT_TYPE).toBe("codex");
      },
      { timeout: 2000 },
    );
  });

  it("persists powerful + fast model selection to ENV_PREFIX-keyed env", async () => {
    setConfig({ env: { ELIZA_DEFAULT_AGENT_TYPE: "claude" } });
    render(<CodingAgentSettingsSection />);
    await screen.findByRole("button", { name: /^Claude\s/ });

    // FALLBACK_MODELS.anthropic provides claude-opus-4-7 as an option value.
    const powerful = selectWithOption("claude-opus-4-7");
    fireEvent.change(powerful, { target: { value: "claude-opus-4-7" } });
    await waitFor(
      () => {
        const last = updateConfig.mock.calls.at(-1)?.[0] as {
          env: Record<string, string>;
        };
        expect(last?.env.ELIZA_CLAUDE_MODEL_POWERFUL).toBe("claude-opus-4-7");
      },
      { timeout: 2000 },
    );

    // Both selects carry the same option set; the second occurrence is Fast.
    const sonnetSelects = (
      Array.from(document.querySelectorAll("select")) as HTMLSelectElement[]
    ).filter((s) =>
      Array.from(s.options).some((o) => o.value === "claude-sonnet-4-6"),
    );
    expect(sonnetSelects.length).toBe(2);
    fireEvent.change(sonnetSelects[1], {
      target: { value: "claude-sonnet-4-6" },
    });
    await waitFor(
      () => {
        const last = updateConfig.mock.calls.at(-1)?.[0] as {
          env: Record<string, string>;
        };
        expect(last?.env.ELIZA_CLAUDE_MODEL_FAST).toBe("claude-sonnet-4-6");
      },
      { timeout: 2000 },
    );
  });

  it("prefers fetched models and falls back to FALLBACK_MODELS on fetch failure", async () => {
    setConfig({ env: { ELIZA_DEFAULT_AGENT_TYPE: "claude" } });
    fetchModels.mockImplementation(async (provider: string) => {
      if (provider === "anthropic") {
        return {
          provider: "anthropic",
          models: [{ id: "claude-x", name: "Claude X", category: "chat" }],
        };
      }
      return { provider, models: [] };
    });
    const { unmount } = render(<CodingAgentSettingsSection />);
    await screen.findByRole("button", { name: /^Claude\s/ });
    // Fetched model option present, fallback NOT used.
    expect(selectWithOption("claude-x")).toBeTruthy();
    const fetchedOption = Array.from(selectWithOption("claude-x").options).find(
      (o) => o.value === "claude-x",
    );
    expect(fetchedOption?.textContent).toBe("Claude X");
    unmount();

    // Now make fetch reject -> .catch(() => null) -> FALLBACK_MODELS.anthropic.
    fetchModels.mockImplementation(async () => {
      throw new Error("models endpoint down");
    });
    render(<CodingAgentSettingsSection />);
    await screen.findByRole("button", { name: /^Claude\s/ });
    const fallback = Array.from(
      selectWithOption("claude-opus-4-7").options,
    ).find((o) => o.value === "claude-opus-4-7");
    expect(fallback?.textContent).toBe("Claude Opus 4.7");
  });

  it("persists the approval-preset change", async () => {
    render(<CodingAgentSettingsSection />);
    await screen.findByRole("button", { name: /elizaOS/ });
    // The approval-preset select is the one carrying 'autonomous'.
    const presetSelect = selectWithOption("autonomous");
    fireEvent.change(presetSelect, { target: { value: "autonomous" } });
    await waitFor(
      () => {
        const last = updateConfig.mock.calls.at(-1)?.[0] as {
          env: Record<string, string>;
        };
        expect(last?.env.ELIZA_DEFAULT_APPROVAL_PRESET).toBe("autonomous");
      },
      { timeout: 2000 },
    );
  });

  it("persists the selection-strategy change", async () => {
    render(<CodingAgentSettingsSection />);
    await screen.findByRole("button", { name: /elizaOS/ });
    // The selection-strategy select is the one carrying 'ranked'.
    const stratSelect = selectWithOption("ranked");
    fireEvent.change(stratSelect, { target: { value: "ranked" } });
    await waitFor(
      () => {
        const last = updateConfig.mock.calls.at(-1)?.[0] as {
          env: Record<string, string>;
        };
        expect(last?.env.ELIZA_AGENT_SELECTION_STRATEGY).toBe("ranked");
      },
      { timeout: 2000 },
    );
  });

  it("does NOT auto-save on initial load with no user interaction (autoSaveArmedRef guard)", async () => {
    render(<CodingAgentSettingsSection />);
    await screen.findByRole("button", { name: /elizaOS/ });
    // Give the 400ms debounce ample real time to fire if the guard were broken.
    await new Promise((r) => setTimeout(r, 600));
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it("strips synthetic '_'-prefixed keys (e.g. _CLOUD_API_KEY) from the env patch", async () => {
    setConfig({
      env: { ELIZA_DEFAULT_AGENT_TYPE: "claude" },
      cloud: { apiKey: "cloud-secret-123" },
    });
    render(<CodingAgentSettingsSection />);
    const codexTab = await screen.findByRole("button", { name: /^Codex\s/ });
    fireEvent.click(codexTab);
    await waitFor(
      () => {
        expect(updateConfig).toHaveBeenCalled();
      },
      { timeout: 2000 },
    );
    const env = (
      updateConfig.mock.calls.at(-1)?.[0] as {
        env: Record<string, string>;
      }
    ).env;
    expect(Object.keys(env).some((k) => k.startsWith("_"))).toBe(false);
    expect(env._CLOUD_API_KEY).toBeUndefined();
    // The real env value must still be present (proves we didn't drop everything).
    expect(env.ELIZA_DEFAULT_AGENT_TYPE).toBe("codex");
  });

  it("surfaces a failed save in a role='alert' banner", async () => {
    setConfig({ env: { ELIZA_DEFAULT_AGENT_TYPE: "claude" } });
    updateConfig.mockRejectedValue(new Error("disk full"));
    render(<CodingAgentSettingsSection />);
    const codexTab = await screen.findByRole("button", { name: /^Codex\s/ });
    fireEvent.click(codexTab);
    const alert = await waitFor(() => screen.getByRole("alert"), {
      timeout: 2000,
    });
    expect(alert.textContent).toContain("Failed to save settings: disk full");
  });

  it("renders the no-installed-CLIs install list when preflight reports none installed", async () => {
    preflightRows = [
      {
        adapter: "claude code",
        installed: false,
        installCommand: "npm i -g x",
      },
      { adapter: "openai codex", installed: false },
    ];
    render(<CodingAgentSettingsSection />);
    // NoSupportedCLIs key has no defaultValue -> raw key rendered.
    await screen.findByText("codingagentsettingssection.NoSupportedCLIs");
    // Every framework label appears in the install list...
    for (const label of [
      "elizaOS",
      "Pi Agent",
      "OpenCode",
      "Claude",
      "Codex",
    ]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    // ...but the tab buttons (aria-label `${label} ${statusLabel}`) are NOT shown.
    expect(screen.queryByRole("button", { name: /^Claude\s/ })).toBeNull();
    expect(screen.queryByRole("group")).toBeNull();
  });

  it("encodes install state into the tab aria-label (installed vs missing)", async () => {
    preflightRows = [
      {
        adapter: "claude code",
        installed: true,
        auth: { status: "authenticated" },
      },
      { adapter: "openai codex", installed: false },
    ];
    render(<CodingAgentSettingsSection />);
    // Only installed agents are tabbed when at least one is installed.
    const claudeTab = await screen.findByRole("button", { name: /^Claude\s/ });
    expect(claudeTab.getAttribute("aria-label")).toContain(
      "codingagentsettingssection.Installed",
    );
    // Codex is missing -> not tabbed in this branch.
    expect(screen.queryByRole("button", { name: /^Codex\s/ })).toBeNull();
  });

  it("shows the needs-auth banner and POSTs to /api/coding-agents/auth/{agent} on Sign in", async () => {
    setConfig({
      env: {
        ELIZA_LLM_PROVIDER: "subscription",
        ELIZA_DEFAULT_AGENT_TYPE: "claude",
      },
    });
    preflightRows = [
      {
        adapter: "claude code",
        installed: true,
        auth: { status: "unauthenticated" },
      },
    ];
    render(<CodingAgentSettingsSection />);
    await screen.findByRole("button", { name: /^Claude\s/ });
    // The KeyRound 'Authentication required' banner + Sign in button render.
    const signIn = await screen.findByText("Sign in");
    fireEvent.click(signIn);
    await waitFor(() => {
      expect(
        authFetchCalls.some(
          (c) =>
            c.url === "/api/coding-agents/auth/claude" &&
            c.init?.method === "POST",
        ),
      ).toBe(true);
    });
  });
});

describe("GitHubConnectionCard (via the settings section)", () => {
  // The card is only rendered when the section is past loading and has tabs.
  async function renderSection() {
    render(<CodingAgentSettingsSection />);
    await screen.findByRole("button", { name: /elizaOS/ });
  }

  it("renders the disconnected state and connects a pasted token", async () => {
    githubFetch.mockResolvedValueOnce({ connected: false }); // initial GET
    await renderSection();
    await screen.findByLabelText("Not connected");
    const input = document.querySelector(
      'input[placeholder="ghp_…"]',
    ) as HTMLInputElement;
    expect(input).toBeTruthy();

    const connect = screen.getByRole("button", { name: "Connect" });
    expect((connect as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(input, { target: { value: "ghp_realtoken" } });
    expect(
      (screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);

    githubFetch.mockResolvedValueOnce({
      connected: true,
      username: "octocat",
      scopes: ["repo"],
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await screen.findByLabelText("Connected as @octocat");
    const postCall = githubFetch.mock.calls.find(
      (c) => c[1] && (c[1] as RequestInit).method === "POST",
    );
    expect(postCall?.[0]).toBe("/api/github/token");
    expect(String((postCall?.[1] as RequestInit).body)).toContain(
      "ghp_realtoken",
    );
  });

  it("renders the connected state initially and disconnects", async () => {
    githubFetch.mockResolvedValueOnce({
      connected: true,
      username: "octocat",
      scopes: ["repo", "read:user"],
    });
    await renderSection();
    await screen.findByLabelText("Connected as @octocat");
    expect(screen.getByText(/repo, read:user/)).toBeTruthy();

    const disconnect = screen.getByRole("button", { name: /Disconnect/ });
    githubFetch.mockResolvedValueOnce(undefined); // DELETE resolves
    fireEvent.click(disconnect);

    await screen.findByLabelText("Not connected");
    const deleteCall = githubFetch.mock.calls.find(
      (c) => c[1] && (c[1] as RequestInit).method === "DELETE",
    );
    expect(deleteCall?.[0]).toBe("/api/github/token");
  });

  it("opens the github token-generation page", async () => {
    githubFetch.mockResolvedValueOnce({ connected: false });
    await renderSection();
    await screen.findByLabelText("Not connected");
    const genLink = screen.getByText(/Generate a token on github.com/);
    fireEvent.click(genLink);
    expect(openExternalUrl).toHaveBeenCalledTimes(1);
    expect(String(openExternalUrl.mock.calls[0][0])).toMatch(
      /^https:\/\/github\.com\/settings\/tokens\/new/,
    );
  });

  it("shows the server's error message when connect returns {error}", async () => {
    githubFetch.mockResolvedValueOnce({ connected: false }); // initial GET
    await renderSection();
    const input = (await waitFor(() =>
      document.querySelector('input[placeholder="ghp_…"]'),
    )) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "ghp_bad" } });
    githubFetch.mockResolvedValueOnce({ error: "bad token" }); // POST
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByText("bad token")).toBeTruthy();
    // Still disconnected after a failed connect.
    expect(screen.getByLabelText("Not connected")).toBeTruthy();
  });
});

// --- Supplementary boundary-helper edge cases ------------------------------
// These add ONLY cases not already covered by the co-located
// src/api/*.test.ts files (no duplicate scenarios).

describe("sanitizeAuthResult — additional edge cases", () => {
  it("drops a protocol-relative URL (no base -> new URL throws)", () => {
    expect(
      sanitizeAuthResult({ url: "//evil.com/login", instructions: "fallback" }),
    ).toEqual({ instructions: "fallback" });
  });

  it("accepts an uppercase scheme (URL normalizes protocol to lowercase)", () => {
    expect(sanitizeAuthResult({ url: "HTTPS://example.com/x" })).toEqual({
      url: "HTTPS://example.com/x",
    });
  });

  it("omits a non-string url (number) while keeping the rest", () => {
    expect(
      sanitizeAuthResult({ url: 123, instructions: "do this", launched: true }),
    ).toEqual({ instructions: "do this", launched: true });
  });

  it("strips unknown fields down to the whitelist even with a valid url", () => {
    expect(
      sanitizeAuthResult({
        url: "https://ok.example/login",
        instructions: "go",
        secretToken: "leak",
        extra: { nested: true },
      }),
    ).toEqual({ url: "https://ok.example/login", instructions: "go" });
  });
});

describe("normalizePreflightAuth — additional edge cases", () => {
  it("treats whitespace-padded status as unknown (exact match only)", () => {
    expect(normalizePreflightAuth({ status: " authenticated " })).toEqual({
      status: "unknown",
    });
  });

  it("treats empty-string status as unknown", () => {
    expect(normalizePreflightAuth({ status: "" })).toEqual({
      status: "unknown",
    });
  });

  it("round-trips status + all whitelisted display fields", () => {
    expect(
      normalizePreflightAuth({
        status: "authenticated",
        method: "device-code",
        detail: "all set",
        loginHint: "user@host",
      }),
    ).toEqual({
      status: "authenticated",
      method: "device-code",
      detail: "all set",
      loginHint: "user@host",
    });
  });

  it("returns {status:'unknown'} for an array input with no status", () => {
    // typeof [] === "object" so it passes the object guard; no status field.
    expect(normalizePreflightAuth([])).toEqual({ status: "unknown" });
  });
});
