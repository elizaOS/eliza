// @vitest-environment jsdom
//
// Behavioral coverage for the SECURITY-CRITICAL wallet policy surface
// (PolicyControlsView). This view lets the owner configure the guardrails that
// gate autonomous wallet actions — spend limits, auto-approve threshold,
// allow/deny address lists, rate limits, time windows — and persists them to
// the Steward backend.
//
// NOTE ON REGISTRATION: PolicyControlsView is a public `@elizaos/ui` export
// (components/index.ts) but is NOT wired into settings-sections.ts (only
// PermissionsSection / AppPermissionsSection are). It is the ONLY component in
// the package that implements the allow/deny policy semantics + the exact
// `client.setStewardPolicies` persistence call this FOCUS requires, so it is the
// correct unit to test for policy behavior; the registered PermissionsSection
// carries no policy-persistence surface. This gap is noted for the maintainer.
//
// The Steward wallet API (`client` from ../../api) is the ONLY collaborator we
// mock. Everything under test — the load/connect gate, the dirty/save state
// machine, the disable-guardrail confirm gate, address allow/deny mode, and the
// address validation/dedupe rules — runs for real.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type PolicyRuleWire = {
  id: string;
  type: string;
  enabled: boolean;
  config: Record<string, unknown>;
};

const api = vi.hoisted(() => ({
  client: {
    getStewardStatus: vi.fn(),
    getStewardPolicies: vi.fn(),
    setStewardPolicies: vi.fn(),
  },
}));
vi.mock("../../api", () => api);

// STABLE translation object — a fresh `{ t }` per render would change `t` every
// render and re-fire the `[t]` load effect → setState → re-render → infinite
// loop (whole file hangs). Mirror the real stable useTranslation.
const i18nMock = vi.hoisted(() => {
  const t = (key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? key;
  return { t, uiLanguage: "en", setUiLanguage: () => {} };
});
vi.mock("../../state/TranslationContext.hooks", () => ({
  useTranslation: () => i18nMock,
}));

vi.mock("../../agent-surface", () => ({
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
}));

vi.mock("../steward/injected", () => ({
  StewardLogo: () => null,
}));

import { PolicyControlsView } from "./PolicyControlsView";

const client = api.client;

/** A stable EVM address used across add/dedupe tests. */
const EVM_ADDR = `0x${"a".repeat(40)}`;

function mockConnected(policies: PolicyRuleWire[]): void {
  client.getStewardStatus.mockResolvedValue({ connected: true });
  client.getStewardPolicies.mockResolvedValue(policies);
  client.setStewardPolicies.mockResolvedValue(undefined);
}

/** Render + wait for the connected view (a policy switch) to appear. */
async function renderConnected(policies: PolicyRuleWire[]): Promise<void> {
  mockConnected(policies);
  render(<PolicyControlsView />);
  await screen.findByRole("switch", { name: "Auto-Approve" });
}

function policyPayload(): PolicyRuleWire[] {
  const call = client.setStewardPolicies.mock.calls.at(-1);
  if (!call) throw new Error("setStewardPolicies was never called");
  return call[0] as PolicyRuleWire[];
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("PolicyControlsView — connect gate", () => {
  it("does NOT fetch policies until Steward reports connected (security gate)", async () => {
    client.getStewardStatus.mockResolvedValue({ connected: false });
    client.getStewardPolicies.mockResolvedValue([]);

    render(<PolicyControlsView />);

    // Not-connected empty state is shown...
    expect(await screen.findByText("Steward Not Connected")).toBeTruthy();
    // ...and the policy list was never requested when disconnected.
    expect(client.getStewardPolicies).not.toHaveBeenCalled();
    // No policy controls are exposed.
    expect(screen.queryByRole("switch", { name: "Auto-Approve" })).toBeNull();
  });

  it("renders the loaded enabled/disabled state of each policy", async () => {
    await renderConnected([
      {
        id: "aa1",
        type: "auto-approve-threshold",
        enabled: true,
        config: { threshold: "5" },
      },
    ]);

    // Enabled policy → switch reflects checked.
    expect(
      screen
        .getByRole("switch", { name: "Auto-Approve" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    // A policy absent from the payload defaults to disabled.
    expect(
      screen
        .getByRole("switch", { name: "Spending Limits" })
        .getAttribute("aria-checked"),
    ).toBe("false");
  });
});

describe("PolicyControlsView — enable + persist", () => {
  it("enabling a policy marks dirty and Save fires setStewardPolicies with the exact rule", async () => {
    await renderConnected([]);

    // No unsaved state initially.
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();

    fireEvent.click(screen.getByRole("switch", { name: "Auto-Approve" }));

    // Dirty → Save surfaces. Persist not yet called (explicit save required).
    const saveBtn = await screen.findByRole("button", { name: "Save" });
    expect(client.setStewardPolicies).not.toHaveBeenCalled();

    fireEvent.click(saveBtn);
    await screen.findByText("Saved");

    expect(client.setStewardPolicies).toHaveBeenCalledTimes(1);
    const payload = policyPayload();
    const rule = payload.find((p) => p.type === "auto-approve-threshold");
    expect(rule).toBeTruthy();
    expect(rule?.enabled).toBe(true);
    // Default config is seeded on enable (threshold in USD).
    expect(rule?.config.threshold).toBe("5");
  });

  it("a failed persist surfaces the error and does NOT flip to Saved", async () => {
    await renderConnected([]);
    client.setStewardPolicies.mockRejectedValueOnce(new Error("boom-network"));

    fireEvent.click(screen.getByRole("switch", { name: "Auto-Approve" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));

    expect(await screen.findByText("boom-network")).toBeTruthy();
    expect(screen.queryByText("Saved")).toBeNull();
    // Still dirty → Save remains available for retry.
    expect(screen.queryByRole("button", { name: "Save" })).toBeTruthy();
  });
});

describe("PolicyControlsView — disable guardrail confirm gate", () => {
  it("disabling an enabled policy is gated by a confirm dialog; Keep leaves it enabled", async () => {
    await renderConnected([
      {
        id: "aa1",
        type: "auto-approve-threshold",
        enabled: true,
        config: { threshold: "5" },
      },
    ]);

    const toggle = screen.getByRole("switch", { name: "Auto-Approve" });
    fireEvent.click(toggle);

    // The toggle did NOT immediately disable — a confirm gate intercepts it.
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(
      screen.getByText(
        "Disabling this removes a safety guardrail. Are you sure?",
      ),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    // Cancelling keeps the guardrail on and clean.
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("confirming the disable dialog turns the policy off and persists enabled:false", async () => {
    await renderConnected([
      {
        id: "aa1",
        type: "auto-approve-threshold",
        enabled: true,
        config: { threshold: "5" },
      },
    ]);

    const toggle = screen.getByRole("switch", { name: "Auto-Approve" });
    fireEvent.click(toggle);
    fireEvent.click(await screen.findByRole("button", { name: "Disable" }));

    expect(toggle.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(await screen.findByRole("button", { name: "Save" }));
    await screen.findByText("Saved");

    const rule = policyPayload().find(
      (p) => p.type === "auto-approve-threshold",
    );
    expect(rule?.enabled).toBe(false);
  });
});

describe("PolicyControlsView — address allow/deny + validation", () => {
  function connectedAddressPolicy(): PolicyRuleWire[] {
    return [
      {
        id: "addr1",
        type: "approved-addresses",
        enabled: true,
        config: { addresses: [], labels: {}, mode: "whitelist" },
      },
    ];
  }

  it("rejects an invalid address and does not add it", async () => {
    mockConnected(connectedAddressPolicy());
    render(<PolicyControlsView />);
    const input = await screen.findByPlaceholderText("EVM or Solana address");

    fireEvent.change(input, { target: { value: "not-an-address" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(
      screen.getByText("Invalid address (EVM 0x... or Solana base58)"),
    ).toBeTruthy();
    // Nothing was added → no remove control rendered.
    expect(screen.queryByText("remove")).toBeNull();
  });

  it("adds a valid address, dedupes a repeat add (idempotent), and persists it under blocklist (deny) mode", async () => {
    mockConnected(connectedAddressPolicy());
    render(<PolicyControlsView />);
    const input = await screen.findByPlaceholderText("EVM or Solana address");
    const addBtn = screen.getByRole("button", { name: "Add" });

    // First add — valid EVM address.
    fireEvent.change(input, { target: { value: EVM_ADDR } });
    fireEvent.click(addBtn);
    expect(screen.getByText(EVM_ADDR)).toBeTruthy();

    // Rapid-fire duplicate add is rejected as a dupe, not doubled.
    fireEvent.change(input, { target: { value: EVM_ADDR } });
    fireEvent.click(addBtn);
    fireEvent.click(addBtn);
    expect(screen.getByText("Already in list")).toBeTruthy();
    expect(screen.getAllByText(EVM_ADDR)).toHaveLength(1);

    // Flip allow → deny (whitelist → blacklist) and persist.
    fireEvent.click(screen.getByRole("button", { name: "Blocklist" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));
    await screen.findByText("Saved");

    const rule = policyPayload().find((p) => p.type === "approved-addresses");
    expect(rule?.enabled).toBe(true);
    expect((rule?.config as { mode: string }).mode).toBe("blacklist");
    expect((rule?.config as { addresses: string[] }).addresses).toEqual([
      EVM_ADDR,
    ]);
  });
});

describe("PolicyControlsView — adversarial numeric input", () => {
  it("filters non-numeric threshold input and persists only sanitized values", async () => {
    await renderConnected([
      {
        id: "aa1",
        type: "auto-approve-threshold",
        enabled: true,
        config: { threshold: "5" },
      },
    ]);

    const field = screen.getByRole("textbox") as HTMLInputElement;
    expect(field.value).toBe("5");

    // Letters are rejected by the input filter → value unchanged.
    fireEvent.change(field, { target: { value: "12abc" } });
    expect(field.value).toBe("5");

    // A valid decimal is accepted.
    fireEvent.change(field, { target: { value: "12.5" } });
    expect(field.value).toBe("12.5");

    fireEvent.click(await screen.findByRole("button", { name: "Save" }));
    await screen.findByText("Saved");

    const rule = policyPayload().find(
      (p) => p.type === "auto-approve-threshold",
    );
    expect(rule?.config.threshold).toBe("12.5");
  });
});
