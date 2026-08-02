/** Exercises compile libllama zig pin behavior with deterministic app-core test fixtures. */
import { describe, expect, it } from "bun:test";
import {
  ABI_TARGETS,
  ALLOW_UNPINNED_ZIG_ENV,
  assertZigPinForTargets,
  PINNED_ZIG_LINK_TRIPLES,
  PINNED_ZIG_SERIES_FOR_MUSL_LINK,
  zigSeries,
  zigTriplesForAbis,
} from "./compile-libllama.mjs";

// Pins zig to the 0.13.x series for the aarch64/x86_64 `*-linux-musl` link.
// zig 0.16's bundled lld SIGSEGVs that link (a silent host-toolchain break);
// 0.13.x links it cleanly. The riscv64 RVV path is exempt (it needs 0.14+).
// See issue #9584.
describe("compile-libllama zig 0.13 pin", () => {
  describe("zigSeries", () => {
    it("extracts MAJOR.MINOR from stable versions", () => {
      expect(zigSeries("0.13.0")).toBe("0.13");
      expect(zigSeries("0.13.7")).toBe("0.13");
      expect(zigSeries("0.16.0")).toBe("0.16");
    });

    it("strips dev/build suffixes", () => {
      expect(zigSeries("0.13.0-dev.46+abc123")).toBe("0.13");
      expect(zigSeries("v0.13.0")).toBe("0.13");
    });

    it("returns null for unparseable input", () => {
      expect(zigSeries("not-a-version")).toBeNull();
      // @ts-expect-error — exercising the non-string guard at the boundary.
      expect(zigSeries(undefined)).toBeNull();
    });
  });

  describe("pin constants", () => {
    it("pins the 0.13 series", () => {
      expect(PINNED_ZIG_SERIES_FOR_MUSL_LINK).toBe("0.13");
    });

    it("covers the aarch64/x86_64 musl link triples but not riscv64", () => {
      expect(PINNED_ZIG_LINK_TRIPLES).toContain("aarch64-linux-musl");
      expect(PINNED_ZIG_LINK_TRIPLES).toContain("x86_64-linux-musl");
      expect(PINNED_ZIG_LINK_TRIPLES).not.toContain("riscv64-linux-musl");
    });
  });

  describe("zigTriplesForAbis", () => {
    it("maps each Android ABI to its zig triple", () => {
      expect(zigTriplesForAbis(["arm64-v8a"])).toEqual(["aarch64-linux-musl"]);
      expect(zigTriplesForAbis(["arm64-v8a", "x86_64", "riscv64"])).toEqual([
        "aarch64-linux-musl",
        "x86_64-linux-musl",
        "riscv64-linux-musl",
      ]);
    });

    it("dedupes repeated ABIs", () => {
      expect(zigTriplesForAbis(["arm64-v8a", "arm64-v8a"])).toEqual([
        "aarch64-linux-musl",
      ]);
    });

    it("stays in sync with ABI_TARGETS", () => {
      const abis = ABI_TARGETS.map((t) => t.androidAbi);
      expect(zigTriplesForAbis(abis)).toEqual(
        ABI_TARGETS.map((t) => t.zigTarget),
      );
    });

    it("throws on an unknown ABI rather than dropping it", () => {
      expect(() => zigTriplesForAbis(["mips"])).toThrow(/unknown Android ABI/);
    });
  });

  describe("assertZigPinForTargets", () => {
    const arm = ["aarch64-linux-musl"];
    const x86 = ["x86_64-linux-musl"];
    const riscv = ["riscv64-linux-musl"];

    it("accepts zig 0.13.x for the pinned musl link triples", () => {
      expect(() =>
        assertZigPinForTargets({ version: "0.13.0", zigTriples: arm, env: {} }),
      ).not.toThrow();
      expect(() =>
        assertZigPinForTargets({ version: "0.13.7", zigTriples: x86, env: {} }),
      ).not.toThrow();
    });

    it("rejects zig 0.16 (lld SIGSEGV) for the pinned link", () => {
      expect(() =>
        assertZigPinForTargets({ version: "0.16.0", zigTriples: arm, env: {} }),
      ).toThrow(/0\.13\.x/);
    });

    it("rejects zig 0.14 for the pinned link (series must match exactly)", () => {
      expect(() =>
        assertZigPinForTargets({ version: "0.14.0", zigTriples: arm, env: {} }),
      ).toThrow();
    });

    it("exempts a riscv64-only run (RVV path needs 0.14+)", () => {
      expect(() =>
        assertZigPinForTargets({
          version: "0.16.0",
          zigTriples: riscv,
          env: {},
        }),
      ).not.toThrow();
      expect(() =>
        assertZigPinForTargets({
          version: "0.14.0",
          zigTriples: riscv,
          env: {},
        }),
      ).not.toThrow();
    });

    it("still rejects when a pinned triple is mixed with riscv64", () => {
      expect(() =>
        assertZigPinForTargets({
          version: "0.16.0",
          zigTriples: [...arm, ...riscv],
          env: {},
        }),
      ).toThrow();
    });

    it("honors the explicit override env", () => {
      expect(() =>
        assertZigPinForTargets({
          version: "0.16.0",
          zigTriples: arm,
          env: { [ALLOW_UNPINNED_ZIG_ENV]: "1" },
        }),
      ).not.toThrow();
    });

    it("rejects a garbage version for the pinned link", () => {
      expect(() =>
        assertZigPinForTargets({ version: "weird", zigTriples: arm, env: {} }),
      ).toThrow();
    });

    it("error names the version, the lld SIGSEGV cause, and the override", () => {
      let message = "";
      try {
        assertZigPinForTargets({ version: "0.16.0", zigTriples: arm, env: {} });
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message).toMatch(/0\.16\.0/);
      expect(message).toMatch(/lld SIGSEGV/i);
      expect(message).toContain(ALLOW_UNPINNED_ZIG_ENV);
    });
  });
});
