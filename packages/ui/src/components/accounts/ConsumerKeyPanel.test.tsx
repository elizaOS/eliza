/**
 * Component coverage for the OWNER-only consumer-key panel: all three list
 * states (loading / error+retry / designed-empty), row rendering, the create
 * and rotate one-time-plaintext flows with copy/dismiss, enable/disable and
 * quota-edit confirmation paths, mutation-failure surfacing, and the OWNER
 * role gate. Deterministic jsdom + testing-library with an injected fake API;
 * no network.
 */

// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ConsumerKeyCreated,
  ConsumerKeySummary,
} from "../../api/client-agent-consumer-keys";
import {
  ConsumerKeyPanel,
  type ConsumerKeyPanelApi,
  ConsumerKeyPanelBody,
} from "./ConsumerKeyPanel";

vi.mock("../../state/app-store", () => ({
  useAppSelector: (
    selector: (state: {
      t: (key: string, vars?: Record<string, unknown>) => string;
      uiLanguage: string;
    }) => unknown,
  ) =>
    selector({
      t: (key, vars) =>
        String(vars?.defaultValue ?? key).replace(
          "{{quota}}",
          String(vars?.quota ?? ""),
        ),
      uiLanguage: mockUiLanguage,
    }),
}));

let mockRole = "OWNER";
let mockUiLanguage = "en";
vi.mock("../../hooks/useRole.tsx", () => ({
  useRole: () => ({ role: mockRole }),
}));

const clipboardWrites: string[] = [];

beforeEach(() => {
  mockRole = "OWNER";
  mockUiLanguage = "en";
  clipboardWrites.length = 0;
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: (text: string) => {
        clipboardWrites.push(text);
        return Promise.resolve();
      },
    },
  });
});

afterEach(() => {
  cleanup();
});

function key(overrides: Partial<ConsumerKeySummary> = {}): ConsumerKeySummary {
  return {
    id: "ck_1",
    label: "proxy-a",
    enabled: true,
    dailyTokenQuota: 1_000_000,
    keyPrefix: "eliza_cp_abcdef1234",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    lastUsedAt: 1_700_000_500_000,
    ...overrides,
  };
}

function makeApi(
  overrides: Partial<ConsumerKeyPanelApi> = {},
): ConsumerKeyPanelApi {
  return {
    listConsumerKeys: vi.fn().mockResolvedValue([]),
    createConsumerKey: vi.fn().mockRejectedValue(new Error("unexpected")),
    updateConsumerKey: vi.fn().mockRejectedValue(new Error("unexpected")),
    rotateConsumerKey: vi.fn().mockRejectedValue(new Error("unexpected")),
    ...overrides,
  };
}

describe("list states", () => {
  it("renders the loading state while the list request is in flight", () => {
    const api = makeApi({
      listConsumerKeys: vi.fn().mockReturnValue(new Promise(() => {})),
    });
    render(<ConsumerKeyPanelBody api={api} />);
    expect(screen.getByTestId("consumer-keys-loading")).toBeTruthy();
  });

  it("cancels the replaced StrictMode list read and renders its successor", async () => {
    const signals: AbortSignal[] = [];
    const list = vi.fn(
      (_timeoutMs?: number, signal?: AbortSignal) =>
        new Promise<ConsumerKeySummary[]>((resolve, reject) => {
          if (!signal) throw new Error("missing cancellation signal");
          signals.push(signal);
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
          if (signals.length === 2) resolve([key()]);
        }),
    );
    render(
      <StrictMode>
        <ConsumerKeyPanelBody api={makeApi({ listConsumerKeys: list })} />
      </StrictMode>,
    );
    await waitFor(() => expect(screen.getByText("proxy-a")).toBeTruthy());
    expect(list).toHaveBeenCalledTimes(2);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    expect(screen.queryByTestId("consumer-keys-error")).toBeNull();
  });

  it("cancels the active list read when the panel unmounts", () => {
    let signal: AbortSignal | undefined;
    const list = vi.fn((_timeoutMs?: number, nextSignal?: AbortSignal) => {
      signal = nextSignal;
      return new Promise<ConsumerKeySummary[]>(() => {});
    });
    const view = render(
      <ConsumerKeyPanelBody api={makeApi({ listConsumerKeys: list })} />,
    );
    expect(signal?.aborted).toBe(false);
    view.unmount();
    expect(signal?.aborted).toBe(true);
  });

  it("renders an explicit error state and retries into data", async () => {
    const list = vi
      .fn()
      .mockRejectedValueOnce(new Error("agent unreachable"))
      .mockResolvedValueOnce([key()]);
    render(<ConsumerKeyPanelBody api={makeApi({ listConsumerKeys: list })} />);
    await waitFor(() =>
      expect(screen.getByTestId("consumer-keys-error")).toBeTruthy(),
    );
    fireEvent.click(screen.getByText("Retry"));
    await waitFor(() => expect(screen.getByText("proxy-a")).toBeTruthy());
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("renders the designed-empty state for zero keys", async () => {
    render(<ConsumerKeyPanelBody api={makeApi()} />);
    await waitFor(() =>
      expect(screen.getByTestId("consumer-keys-empty")).toBeTruthy(),
    );
  });

  it("renders label, prefix, quota, status, and timestamps for each key", async () => {
    const api = makeApi({
      listConsumerKeys: vi.fn().mockResolvedValue([
        key(),
        key({
          id: "ck_2",
          label: "proxy-b",
          enabled: false,
          dailyTokenQuota: null,
        }),
      ]),
    });
    render(<ConsumerKeyPanelBody api={api} />);
    await waitFor(() => expect(screen.getByText("proxy-a")).toBeTruthy());
    expect(screen.getByText("proxy-b")).toBeTruthy();
    expect(screen.getAllByText(/eliza_cp_abcdef1234/)).toHaveLength(2);
    expect(screen.getByText("Enabled")).toBeTruthy();
    expect(screen.getByText("Disabled")).toBeTruthy();
    expect(screen.getByText("1,000,000 tokens/day")).toBeTruthy();
    expect(screen.getByText("No quota")).toBeTruthy();
  });

  it("formats quotas with the explicit app language", async () => {
    mockUiLanguage = "es";
    render(
      <ConsumerKeyPanelBody
        api={makeApi({ listConsumerKeys: vi.fn().mockResolvedValue([key()]) })}
      />,
    );
    await waitFor(() =>
      expect(screen.getByText("1.000.000 tokens/day")).toBeTruthy(),
    );
  });
});

describe("create flow (one-time plaintext)", () => {
  it("creates a key, shows the one-time banner once, copies, and dismisses", async () => {
    const created: ConsumerKeyCreated = {
      key: "eliza_cp_plain_SECRET",
      consumer: key({ id: "ck_new", label: "new-proxy" }),
    };
    const api = makeApi({
      createConsumerKey: vi.fn().mockResolvedValue(created),
    });
    render(<ConsumerKeyPanelBody api={api} />);
    await waitFor(() =>
      expect(screen.getByTestId("consumer-keys-empty")).toBeTruthy(),
    );
    fireEvent.click(screen.getByText("Create key"));
    fireEvent.change(screen.getByPlaceholderText("protocol-proxy"), {
      target: { value: "new-proxy" },
    });
    fireEvent.click(screen.getByText("Create"));
    await waitFor(() =>
      expect(screen.getByTestId("one-time-key")).toBeTruthy(),
    );
    expect(screen.getByTestId("one-time-key-value").textContent).toBe(
      "eliza_cp_plain_SECRET",
    );
    expect(api.createConsumerKey).toHaveBeenCalledWith({
      label: "new-proxy",
      dailyTokenQuota: null,
    });

    fireEvent.click(screen.getByText("Copy"));
    await waitFor(() =>
      expect(clipboardWrites).toContain("eliza_cp_plain_SECRET"),
    );

    fireEvent.click(screen.getByText("Dismiss"));
    expect(screen.queryByTestId("one-time-key")).toBeNull();
    // The plaintext is gone for good; only the prefix remains in the row.
    expect(screen.queryByText("eliza_cp_plain_SECRET")).toBeNull();
    expect(screen.getByText("new-proxy")).toBeTruthy();
  });

  it("rejects a non-integer quota locally without calling the API", async () => {
    const api = makeApi();
    render(<ConsumerKeyPanelBody api={api} />);
    await waitFor(() =>
      expect(screen.getByTestId("consumer-keys-empty")).toBeTruthy(),
    );
    fireEvent.click(screen.getByText("Create key"));
    fireEvent.change(screen.getByPlaceholderText("1000000"), {
      target: { value: "-5" },
    });
    fireEvent.click(screen.getByText("Create"));
    await waitFor(() =>
      expect(screen.getByTestId("consumer-keys-action-error")).toBeTruthy(),
    );
    expect(api.createConsumerKey).not.toHaveBeenCalled();
  });
});

describe("rotate / enable / disable / quota", () => {
  it("rotates only after inline confirmation and shows the one-time key", async () => {
    const api = makeApi({
      listConsumerKeys: vi.fn().mockResolvedValue([key()]),
      rotateConsumerKey: vi.fn().mockResolvedValue({
        key: "eliza_cp_rotated_SECRET",
        consumer: key({ keyPrefix: "eliza_cp_rotated12" }),
      }),
    });
    render(<ConsumerKeyPanelBody api={api} />);
    await waitFor(() => expect(screen.getByText("proxy-a")).toBeTruthy());
    fireEvent.click(screen.getByText("Rotate"));
    expect(api.rotateConsumerKey).not.toHaveBeenCalled();
    expect(screen.getByText(/Rotate this key\?/)).toBeTruthy();
    fireEvent.click(screen.getByText("Confirm"));
    await waitFor(() =>
      expect(screen.getByTestId("one-time-key-value").textContent).toBe(
        "eliza_cp_rotated_SECRET",
      ),
    );
    expect(api.rotateConsumerKey).toHaveBeenCalledWith("ck_1");
    expect(screen.getByText(/eliza_cp_rotated12/)).toBeTruthy();
  });

  it("cancelling a rotate confirmation performs nothing", async () => {
    const api = makeApi({
      listConsumerKeys: vi.fn().mockResolvedValue([key()]),
    });
    render(<ConsumerKeyPanelBody api={api} />);
    await waitFor(() => expect(screen.getByText("proxy-a")).toBeTruthy());
    fireEvent.click(screen.getByText("Rotate"));
    fireEvent.click(screen.getByText("Cancel"));
    expect(api.rotateConsumerKey).not.toHaveBeenCalled();
    expect(screen.queryByText(/Rotate this key\?/)).toBeNull();
  });

  it("disable requires confirmation; enable applies directly", async () => {
    const disabled = key({ enabled: false });
    const api = makeApi({
      listConsumerKeys: vi.fn().mockResolvedValue([key()]),
      updateConsumerKey: vi.fn().mockResolvedValue(disabled),
    });
    render(<ConsumerKeyPanelBody api={api} />);
    await waitFor(() => expect(screen.getByText("proxy-a")).toBeTruthy());
    fireEvent.click(screen.getByText("Disable"));
    expect(api.updateConsumerKey).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Confirm"));
    await waitFor(() =>
      expect(api.updateConsumerKey).toHaveBeenCalledWith("ck_1", {
        enabled: false,
      }),
    );
    await waitFor(() => expect(screen.getByText("Disabled")).toBeTruthy());

    (api.updateConsumerKey as ReturnType<typeof vi.fn>).mockResolvedValue(
      key(),
    );
    fireEvent.click(screen.getByText("Enable"));
    await waitFor(() =>
      expect(api.updateConsumerKey).toHaveBeenCalledWith("ck_1", {
        enabled: true,
      }),
    );
  });

  it("edits the quota through the inline editor", async () => {
    const api = makeApi({
      listConsumerKeys: vi.fn().mockResolvedValue([key()]),
      updateConsumerKey: vi
        .fn()
        .mockResolvedValue(key({ dailyTokenQuota: 5000 })),
    });
    render(<ConsumerKeyPanelBody api={api} />);
    await waitFor(() => expect(screen.getByText("proxy-a")).toBeTruthy());
    fireEvent.click(screen.getByText("Edit quota"));
    fireEvent.change(
      screen.getByLabelText("Daily token quota (blank = unlimited)"),
      { target: { value: "5000" } },
    );
    fireEvent.click(screen.getByText("Save quota"));
    await waitFor(() =>
      expect(api.updateConsumerKey).toHaveBeenCalledWith("ck_1", {
        dailyTokenQuota: 5000,
      }),
    );
  });

  it("surfaces mutation failures as a visible action error", async () => {
    const api = makeApi({
      listConsumerKeys: vi.fn().mockResolvedValue([key({ enabled: false })]),
      updateConsumerKey: vi.fn().mockRejectedValue(new Error("403 forbidden")),
    });
    render(<ConsumerKeyPanelBody api={api} />);
    await waitFor(() => expect(screen.getByText("proxy-a")).toBeTruthy());
    fireEvent.click(screen.getByText("Enable"));
    await waitFor(() =>
      expect(
        screen.getByTestId("consumer-keys-action-error").textContent,
      ).toContain("403 forbidden"),
    );
  });
});

describe("role gate", () => {
  it("shows the owner-only notice to non-OWNER roles", () => {
    mockRole = "GUEST";
    render(<ConsumerKeyPanel api={makeApi()} />);
    expect(screen.queryByTestId("consumer-keys-panel")).toBeNull();
    expect(screen.queryByTestId("consumer-keys-loading")).toBeNull();
    expect(
      screen.getByText(/available to the workspace owner only/),
    ).toBeTruthy();
  });

  it("renders the panel for OWNER", async () => {
    mockRole = "OWNER";
    render(<ConsumerKeyPanel api={makeApi()} />);
    await waitFor(() =>
      expect(screen.getByTestId("consumer-keys-empty")).toBeTruthy(),
    );
  });
});
