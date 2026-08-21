/**
 * Owner-facing connector fallback coverage. The panel must identify protected
 * credential locations without ever receiving or rendering credential values.
 * @vitest-environment jsdom
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VaultInventoryPanel } from "./VaultInventoryPanel";

vi.mock("../../agent-surface", () => ({
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
}));

vi.mock("../../state/TranslationContext.hooks", () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? _key,
  }),
}));

afterEach(cleanup);

describe("VaultInventoryPanel connector security findings", () => {
  it("shows non-revealing credential locations outside encrypted Vault storage", () => {
    render(
      <VaultInventoryPanel
        entries={[]}
        securityFindings={[
          {
            id: "state:telegram-account:session",
            connector: "telegram-account",
            label: "Telegram Personal session",
            source: "state-file",
            protection: "mode-0600",
            autoMigratesOnDesktop: false,
            detail:
              "Protected by local file permissions, but not encrypted by Vault.",
          },
        ]}
      />,
    );

    expect(screen.getByTestId("vault-security-findings")).toBeTruthy();
    expect(screen.getByText("Telegram Personal session")).toBeTruthy();
    expect(screen.getByText(/outside encrypted Vault storage/)).toBeTruthy();
    expect(screen.queryByText(/session-secret/)).toBeNull();
  });
});

// A scan that failed is not a scan that found nothing. Rendering the empty
// list would tell an owner their connector credentials are clean when the
// server never established that - the worst default for a security surface.
describe("unavailable connector scan", () => {
  it("says the scan did not run instead of showing a clean result", () => {
    render(
      <VaultInventoryPanel
        entries={[]}
        securityFindings={[]}
        securityFindingsAvailable={false}
      />,
    );

    expect(
      screen.getByTestId("vault-security-findings-unavailable"),
    ).toBeTruthy();
    expect(screen.queryByTestId("vault-security-findings")).toBeNull();
  });

  it("renders findings normally when the scan did run", () => {
    render(
      <VaultInventoryPanel
        entries={[]}
        securityFindings={[
          {
            id: "state:telegram-account:session",
            connector: "telegram-account",
            label: "Telegram Personal session",
            source: "state-file",
            protection: "mode-0600",
            autoMigratesOnDesktop: false,
            detail: "Protected by local file permissions, not encrypted.",
          },
        ]}
        securityFindingsAvailable={true}
      />,
    );

    expect(screen.getByTestId("vault-security-findings")).toBeTruthy();
    expect(
      screen.queryByTestId("vault-security-findings-unavailable"),
    ).toBeNull();
  });
});
