// @vitest-environment jsdom
//
// Honest "Active" copy in the AI Model summary row. Selecting a coding-plan
// subscription (e.g. "Claude Subscription") does NOT move the main chat
// inference — `applySubscriptionProviderConfig` (packages/agent/src/api/
// provider-switch-config.ts) records it for the task-agent orchestrator and
// only sets a runtime `model.primary` for the Codex plan. A bare "Active"
// summary next to "Claude Subscription" therefore misled users into thinking
// chat had switched to Claude. These tests lock the qualified copy.

import { cleanup, render, screen } from "@testing-library/react";
import { Cloud, KeyRound } from "lucide-react";
import { afterEach, describe, expect, it } from "vitest";
import { ActiveProviderSummary } from "./ProviderSwitcher";
import type { ProviderListEntry } from "./useProviderEntries";

const t = (key: string, vars?: Record<string, unknown>) =>
  typeof vars?.defaultValue === "string" ? vars.defaultValue : key;

function makeEntry(overrides: Partial<ProviderListEntry>): ProviderListEntry {
  return {
    id: "__cloud__",
    icon: Cloud,
    label: "Eliza Cloud",
    category: "cloud",
    status: { tone: "ok", label: "Connected" },
    current: true,
    ...overrides,
  };
}

describe("ActiveProviderSummary — honest active-state copy", () => {
  afterEach(cleanup);

  it("labels a coding-plan subscription 'Active for coding agents' with the chat clarifier", () => {
    render(
      <ActiveProviderSummary
        entry={makeEntry({
          id: "anthropic-subscription",
          icon: KeyRound,
          label: "Claude Subscription",
          category: "subscription",
        })}
        t={t}
      />,
    );

    expect(screen.getByText("Claude Subscription")).toBeTruthy();
    expect(screen.getByText("Active for coding agents")).toBeTruthy();
    expect(
      screen.getByText(
        "Powers coding agents & workflows only — chat replies keep using your selected Intelligence provider (Cloud or Local).",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Active")).toBeNull();
  });

  it("keeps the plain 'Active' for the Codex plan (it may drive runtime inference)", () => {
    render(
      <ActiveProviderSummary
        entry={makeEntry({
          id: "openai-subscription",
          icon: KeyRound,
          label: "ChatGPT Subscription",
          category: "subscription",
        })}
        t={t}
      />,
    );

    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.queryByText("Active for coding agents")).toBeNull();
  });

  it("keeps the plain 'Active' for intelligence providers (Cloud/local)", () => {
    render(<ActiveProviderSummary entry={makeEntry({})} t={t} />);

    expect(screen.getByText("Eliza Cloud")).toBeTruthy();
    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.queryByText("Active for coding agents")).toBeNull();
    expect(
      screen.queryByText(/chat replies keep using your selected Intelligence/),
    ).toBeNull();
  });
});
