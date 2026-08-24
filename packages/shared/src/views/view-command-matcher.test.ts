/**
 * Behavioural coverage for the deterministic view-command matcher: which
 * explicit navigation phrasings resolve to which view id, and which inputs are
 * deliberately rejected (bare nouns in prose, negated commands, companion
 * action requests, over-length input, cloud-apps mentions). Real module, no
 * mocks — the matcher is a pure string decision consumed by the EARLY hook,
 * the VIEWS action, the contextual evaluator gate, and the shared runtime.
 */
import { describe, expect, it } from "vitest";
import { matchViewCommand } from "./view-command-matcher.js";

describe("matchViewCommand", () => {
  it("returns null for missing and empty input", () => {
    expect(matchViewCommand(undefined)).toBeNull();
    expect(matchViewCommand("")).toBeNull();
    expect(matchViewCommand("   ")).toBeNull();
    expect(matchViewCommand("\n\t")).toBeNull();
  });

  it("resolves explicit verb commands to their views", () => {
    expect(matchViewCommand("open settings")).toBe("settings");
    expect(matchViewCommand("Open Settings")).toBe("settings");
    expect(matchViewCommand("show me my calendar")).toBe("calendar");
    expect(matchViewCommand("go to the vault")).toBe("vault");
  });

  it("matches a bare noun only when it is the whole message", () => {
    expect(matchViewCommand("settings")).toBe("settings");
    expect(matchViewCommand("the settings are wrong")).toBeNull();
  });

  it("matches possessive and noun+view-word signals", () => {
    expect(matchViewCommand("my wallet")).toBe("wallet");
    expect(matchViewCommand("mis ajustes")).toBe("settings");
    expect(matchViewCommand("settings page")).toBe("settings");
  });

  it("resolves non-English commands including SOV order", () => {
    expect(matchViewCommand("abre ajustes")).toBe("settings");
    expect(matchViewCommand("abre la configuración")).toBe("settings");
    expect(matchViewCommand("打开设置")).toBe("settings");
    expect(matchViewCommand("設定を開いて")).toBe("settings");
    expect(matchViewCommand("설정 열어줘")).toBe("settings");
  });

  it("sends bare 'go back' home to chat", () => {
    expect(matchViewCommand("go back")).toBe("chat");
    expect(matchViewCommand("  Go back. ")).toBe("chat");
  });

  it("rejects navigation inside a negated clause", () => {
    expect(matchViewCommand("don't open settings")).toBeNull();
    expect(matchViewCommand("do not open settings")).toBeNull();
    expect(matchViewCommand("never open my wallet")).toBeNull();
  });

  it("rejects companion action requests even with view-like nouns", () => {
    expect(matchViewCommand("please render a dance emote")).toBeNull();
  });

  it("rejects input beyond the 160-character command cap", () => {
    const filler = (n: number) => "a".repeat(n);
    expect(matchViewCommand(`open settings ${filler(146)}`)).toBe("settings");
    expect(matchViewCommand(`open settings ${filler(147)}`)).toBeNull();
  });

  it("opens the cloud apps studio on strict commands", () => {
    expect(matchViewCommand("open the cloud apps")).toBe("cloud-apps");
    expect(matchViewCommand("launch app studio")).toBe("cloud-apps");
  });

  it("never treats a named singular cloud app as the studio", () => {
    expect(matchViewCommand("open the cloud app Acme")).toBeNull();
  });

  it("does not let another noun hijack a sentence mentioning cloud apps", () => {
    expect(matchViewCommand("open help for the cloud apps studio")).toBeNull();
  });

  it("prefers higher-priority views when several nouns appear", () => {
    expect(matchViewCommand("open memories and notes")).toBe("memories");
    expect(matchViewCommand("open cockpit and wallet")).toBe("cockpit");
  });
});
