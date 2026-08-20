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
