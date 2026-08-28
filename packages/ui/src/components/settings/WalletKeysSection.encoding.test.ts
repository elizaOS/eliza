/** Wallet-key labels visibly distinguish malformed agent identifiers. */
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

import type { VaultEntryMeta } from "./vault-tabs/types";
import {
  entryDisplayDescription,
  entryDisplayLabel,
} from "./WalletKeysSection";

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
  it("marks a lone percent agent id unavailable", () => {
    expect(() => entryDisplayLabel(meta("agent.%.wallet.evm"))).not.toThrow();
    expect(entryDisplayLabel(meta("agent.%.wallet.evm"))).toBe(
      "Unavailable agent · EVM",
    );
  });

  it("does not present an invalid escape as an agent id", () => {
    expect(entryDisplayLabel(meta("agent.%ZZ.wallet.sol"))).toBe(
      "Unavailable agent · Solana",
    );
  });

  it("marks truncated UTF-8 unavailable", () => {
    expect(entryDisplayLabel(meta("agent.%E0%A4%A.wallet.evm"))).toBe(
      "Unavailable agent · EVM",
    );
  });

  it("still decodes a valid %20 agent id", () => {
    expect(entryDisplayLabel(meta("agent.my%20bot.wallet.evm"))).toBe(
      "agent my bot · EVM",
    );
  });

  it("normalizes the generated backend labels without changing their keys", () => {
    const entry = {
      ...meta("agent.eliza.wallet.evm"),
      label: "agent eliza (evm)",
    };
    expect(entryDisplayLabel(entry)).toBe("agent eliza · EVM");
    expect(entryDisplayDescription(entry)).toBe("EVM wallet key");
    expect(entry.key).toBe("agent.eliza.wallet.evm");
  });

  it("uses a clear Solana label and description", () => {
    const entry = {
      ...meta("agent.eliza.wallet.solana"),
      label: "agent eliza (solana)",
    };
    expect(entryDisplayLabel(entry)).toBe("agent eliza · Solana");
    expect(entryDisplayDescription(entry)).toBe("Solana wallet key");
  });
});
