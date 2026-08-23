/**
 * Unit coverage for the CLI startup banner formatter. The theme layer and the
 * git-commit resolver are mocked so the assertions pin the banner's own
 * composition (title casing, version, commit label) instead of the checkout's
 * real HEAD; everything else runs the shipped module.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isRich: vi.fn(),
  theme: {
    heading: vi.fn((t: string) => `h(${t})`),
    info: vi.fn((t: string) => `i(${t})`),
    muted: vi.fn((t: string) => `m(${t})`),
  },
  resolveCommitHash: vi.fn(() => "abc1234"),
}));

vi.mock("@elizaos/shared", () => ({
  isRich: (...a: unknown[]) => mocks.isRich(...a),
  theme: mocks.theme,
}));
vi.mock("../git-commit", () => ({
  resolveCommitHash: (...a: unknown[]) => mocks.resolveCommitHash(...a),
}));

describe("formatCliBannerLine", () => {
  beforeEach(() => {
    mocks.isRich.mockReset();
    mocks.isRich.mockReturnValue(true);
    mocks.resolveCommitHash.mockReset();
  });

  it("formats a themed banner on rich tty", async () => {
    const { formatCliBannerLine } = await import("../banner.ts");
    expect(formatCliBannerLine("1.0.0", { commit: "c1" })).toBe(
      "h(Eliza) i(1.0.0) m((c1))",
    );
  });

  it("formats a plain banner off rich tty", async () => {
    const { formatCliBannerLine } = await import("../banner.ts");
    mocks.resolveCommitHash.mockReturnValue(null);
    expect(formatCliBannerLine("1.0.0", { richTty: false })).toBe(
      "Eliza 1.0.0 (unknown)",
    );
  });

  it("uppercases the configured app name", async () => {
    const { formatCliBannerLine } = await import("../banner.ts");
    mocks.resolveCommitHash.mockReturnValue(null);
    expect(
      formatCliBannerLine("2.0.0", {
        env: { APP_CLI_NAME: "hermes" },
        richTty: false,
      }),
    ).toBe("Hermes 2.0.0 (unknown)");
  });
});
