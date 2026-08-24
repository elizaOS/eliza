/**
 * Tests for the LockOnButton cva contract (`lockOnButtonVariants`):
 * shared base classes, tone/size segments, default fallbacks, and
 * unknown-key behaviour. Pure function, deterministic, no DOM.
 */
import { describe, expect, it } from "vitest";
import { lockOnButtonVariants } from "./lock-on-button.variants";

const BASE =
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-sm border text-sm font-medium transition-colors    disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 cursor-pointer";

const TONE_SEGMENTS = {
  primary:
    "border-accent bg-accent text-accent-foreground hover:bg-accent-hover",
  outline:
    "border-border bg-bg-elevated text-txt hover:border-border-strong hover:bg-bg-hover",
  ghost:
    "border-transparent bg-transparent text-txt/70 hover:border-border hover:bg-bg-hover hover:text-txt",
  hud: "border-accent/40 bg-accent-subtle text-accent hover:border-accent/70 hover:bg-accent/20",
} as const;

const SIZE_SEGMENTS = {
  sm: "h-8 px-3 text-xs",
  md: "h-10 px-4",
  lg: "h-12 px-6",
} as const;

describe("lockOnButtonVariants", () => {
  it("emits the shared base classes first, then tone, then size", () => {
    const out = lockOnButtonVariants({ variant: "hud", size: "sm" });
    expect(out.startsWith(`${BASE} `)).toBe(true);
    expect(out.indexOf(TONE_SEGMENTS.hud)).toBeGreaterThan(0);
    expect(out.indexOf(SIZE_SEGMENTS.sm)).toBeGreaterThan(
      out.indexOf(TONE_SEGMENTS.hud),
    );
  });

  it("defaults to the primary tone and md size when called with no arguments", () => {
    const out = lockOnButtonVariants();
    expect(out).toBe(`${BASE} ${TONE_SEGMENTS.primary} ${SIZE_SEGMENTS.md}`);
  });

  it.each(Object.entries(TONE_SEGMENTS))(
    "applies the %s tone segment and no other tone segment",
    (tone, segment) => {
      const out = lockOnButtonVariants({
        variant: tone as keyof typeof TONE_SEGMENTS,
      });
      expect(out).toContain(` ${segment}`);
      for (const [other, otherSegment] of Object.entries(TONE_SEGMENTS)) {
        if (other !== tone) {
          expect(out).not.toContain(otherSegment);
        }
      }
    },
  );

  it.each(Object.entries(SIZE_SEGMENTS))(
    "applies the %s size segment and no other size segment",
    (size, segment) => {
      const out = lockOnButtonVariants({
        size: size as keyof typeof SIZE_SEGMENTS,
      });
      expect(out).toContain(` ${segment}`);
      for (const [other, otherSegment] of Object.entries(SIZE_SEGMENTS)) {
        if (other !== size) {
          expect(out).not.toContain(otherSegment);
        }
      }
    },
  );

  it("keeps the primary tone default when only a size override is given", () => {
    const out = lockOnButtonVariants({ size: "lg" });
    expect(out).toBe(`${BASE} ${TONE_SEGMENTS.primary} ${SIZE_SEGMENTS.lg}`);
  });

  it("combines independent tone and size overrides", () => {
    const out = lockOnButtonVariants({ variant: "outline", size: "sm" });
    expect(out).toBe(`${BASE} ${TONE_SEGMENTS.outline} ${SIZE_SEGMENTS.sm}`);
  });

  it("falls back to both defaults when props are explicitly undefined", () => {
    const out = lockOnButtonVariants({
      variant: undefined,
      size: undefined,
    });
    expect(out).toBe(lockOnButtonVariants());
  });

  it("emits no tone classes for an unknown tone instead of throwing", () => {
    const out = lockOnButtonVariants({
      variant: "bogus" as keyof typeof TONE_SEGMENTS,
    });
    expect(out).toBe(`${BASE} ${SIZE_SEGMENTS.md}`);
  });

  it("treats an empty props object exactly like no arguments", () => {
    expect(lockOnButtonVariants({})).toBe(lockOnButtonVariants());
  });
});
