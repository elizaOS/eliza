/** Telephone launch parsing keeps malformed URI numbers non-dialable. */
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
  it("returns an unavailable number for a lone percent escape", () => {
    expect(() => numberFromTelUri("tel:%")).not.toThrow();
    expect(numberFromTelUri("tel:%")).toBe("");
  });

  it("does not preserve an invalid escape as a dialable number", () => {
    expect(numberFromTelUri("tel:%ZZ")).toBe("");
  });

  it("returns unavailable for truncated UTF-8", () => {
    expect(numberFromTelUri("tel:%E0%A4%A")).toBe("");
  });

  it("still decodes a valid %20 number", () => {
    expect(numberFromTelUri("tel:+1%20555")).toBe("+1 555");
  });

  it("returns empty for a null uri", () => {
    expect(numberFromTelUri(null)).toBe("");
  });
});
