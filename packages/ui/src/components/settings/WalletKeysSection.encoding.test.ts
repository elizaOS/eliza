/** Malformed wallet-key agent-id percent-encoding must not throw. */
// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

vi.mock("../../agent-surface", () => ({ useAgentElement: () => undefined }));
vi.mock("../../api/client", () => ({ client: { rawRequest: vi.fn() } }));
vi.mock("../../state/TranslationContext.hooks", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("../RoleGate", () => ({
  RoleGate: ({ children }: { children: unknown }) => children,
  OwnerOnlyNotice: () => null,
}));
vi.mock("../ui/button", () => ({ Button: () => null }));
vi.mock("./settings-agent-rows", () => ({ SettingsInputRow: () => null }));
vi.mock("./settings-layout", () => ({
  SettingsGroup: () => null,
  SettingsRow: () => null,
  SettingsStack: () => null,
}));

import { entryDisplayLabel } from "./WalletKeysSection";
import type { VaultEntryMeta } from "./vault-tabs/types";

function meta(key: string): VaultEntryMeta {
  return {
    key,
    label: key,
    category: "wallet",
    hasProfiles: false,
    kind: "secret",
  };
}

describe("entryDisplayLabel encoding", () => {
  it("keeps the raw agent segment for a lone %", () => {
    expect(() => entryDisplayLabel(meta("agent.%.wallet.evm"))).not.toThrow();
    expect(entryDisplayLabel(meta("agent.%.wallet.evm"))).toBe("% (evm)");
  });

  it("keeps the raw agent segment for %ZZ", () => {
    expect(entryDisplayLabel(meta("agent.%ZZ.wallet.sol"))).toBe("%ZZ (sol)");
  });

  it("keeps the raw agent segment for truncated UTF-8", () => {
    expect(entryDisplayLabel(meta("agent.%E0%A4%A.wallet.evm"))).toBe(
      "%E0%A4%A (evm)",
    );
  });

  it("still decodes a valid %20 agent id", () => {
    expect(entryDisplayLabel(meta("agent.my%20bot.wallet.evm"))).toBe(
      "my bot (evm)",
    );
  });
});
