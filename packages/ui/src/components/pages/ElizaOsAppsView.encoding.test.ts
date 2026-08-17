/** Malformed tel: percent-encoding must not throw. */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../agent-surface", () => ({ useAgentElement: () => undefined }));
vi.mock("../../bridge/plugin-bridge", () => ({ getPlugins: () => ({}) }));
vi.mock("../../state/TranslationContext.hooks", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("../ui/button", () => ({ Button: () => null }));
vi.mock("../ui/input", () => ({ Input: () => null }));
vi.mock("../ui/textarea", () => ({ Textarea: () => null }));
vi.mock("../views/ShellViewAgentSurface", () => ({
  ShellViewAgentSurface: () => null,
}));

import { numberFromTelUri } from "./ElizaOsAppsView";

describe("numberFromTelUri encoding", () => {
  it("keeps the raw number for a lone %", () => {
    expect(() => numberFromTelUri("tel:%")).not.toThrow();
    expect(numberFromTelUri("tel:%")).toBe("%");
  });

  it("keeps the raw number for %ZZ", () => {
    expect(numberFromTelUri("tel:%ZZ")).toBe("%ZZ");
  });

  it("keeps the raw number for truncated UTF-8", () => {
    expect(numberFromTelUri("tel:%E0%A4%A")).toBe("%E0%A4%A");
  });

  it("still decodes a valid %20 number", () => {
    expect(numberFromTelUri("tel:+1%20555")).toBe("+1 555");
  });

  it("returns empty for a null uri", () => {
    expect(numberFromTelUri(null)).toBe("");
  });
});
