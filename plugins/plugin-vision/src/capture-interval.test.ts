/**
 * Capture-interval setting resolution.
 *
 * `screenCaptureInterval` is passed straight to `setInterval`. Node clamps any
 * delay that is non-finite, <= 0, or above the 32-bit signed maximum to 1ms, so
 * a value that slips through becomes a screen-capture busy loop. An absent
 * setting takes the documented default; an explicitly configured value that
 * cannot be honoured is an operator mistake and fails loudly.
 */
import { describe, expect, it } from "vitest";
import { resolveCaptureIntervalMs, VisionService } from "./service";

/** Assert the call throws the typed config error, checked by `code`. */
function expectInvalid(raw: string): void {
  expect(() => resolveCaptureIntervalMs(raw, DEFAULT, NAME)).toThrowError(
    expect.objectContaining({ code: "VISION_CAPTURE_INTERVAL_INVALID" }),
  );
}

const DEFAULT = 2000;
const MAX_TIMER = 2_147_483_647;
const NAME = "SCREEN_CAPTURE_INTERVAL";

describe("resolveCaptureIntervalMs", () => {
  it("uses the documented default when the setting is absent or blank", () => {
    expect(resolveCaptureIntervalMs(undefined, DEFAULT, NAME)).toBe(DEFAULT);
    expect(resolveCaptureIntervalMs("   ", DEFAULT, NAME)).toBe(DEFAULT);
  });

  it("accepts the exact timer maximum", () => {
    expect(resolveCaptureIntervalMs(String(MAX_TIMER), DEFAULT, NAME)).toBe(
      MAX_TIMER,
    );
  });

  it("rejects one millisecond above the timer maximum", () => {
    // Node clamps this to 1ms (TimeoutOverflowWarning), recreating the busy
    // loop this guard exists to prevent.
    expectInvalid(String(MAX_TIMER + 1));
  });

  it("rejects an exponent form that exceeds the timer maximum", () => {
    expectInvalid("1e10");
  });

  it("rejects Infinity and negative values, which Node also clamps to 1ms", () => {
    expectInvalid("Infinity");
    expectInvalid("-5");
  });

  it("rejects a non-numeric configured value rather than substituting the default", () => {
    // The distinction that matters: absent is a default, configured-and-wrong
    // is a mistake the operator needs to see.
    expectInvalid("abc");
  });

  it("accepts a valid interval, including a fractional millisecond", () => {
    expect(resolveCaptureIntervalMs("500", DEFAULT, NAME)).toBe(500);
    expect(resolveCaptureIntervalMs("1500.5", DEFAULT, NAME)).toBe(1500.5);
  });
});

describe("VisionService config wiring", () => {
  function serviceWith(settings: Record<string, string>) {
    const runtime = {
      getSetting: (key: string) => settings[key],
      character: { name: "test", settings: {} },
      getService: () => null,
    } as unknown as ConstructorParameters<typeof VisionService>[0];
    return new VisionService(runtime);
  }

  it("preserves existing alias precedence for a whitespace-only primary", () => {
    // Documented as a deliberate no-change: `getSettingString` returns the
    // whitespace string, which is truthy, so `||` does NOT reach the alias —
    // and `Number("   ")` is 0, which the old code turned into the default.
    // This PR keeps that exact outcome rather than silently widening alias
    // precedence while fixing a timer bug.
    const service = serviceWith({
      SCREEN_CAPTURE_INTERVAL: "   ",
      VISION_SCREEN_CAPTURE_INTERVAL: "750",
    });
    expect(
      (
        service as unknown as {
          visionConfig: { screenCaptureInterval: number };
        }
      ).visionConfig.screenCaptureInterval,
    ).toBe(2000);
  });

  it("uses a valid legacy alias when the primary is entirely absent", () => {
    const service = serviceWith({ VISION_SCREEN_CAPTURE_INTERVAL: "750" });
    expect(
      (
        service as unknown as {
          visionConfig: { screenCaptureInterval: number };
        }
      ).visionConfig.screenCaptureInterval,
    ).toBe(750);
  });

  it("refuses to construct — and so arms no timer — on an invalid configured interval", () => {
    expect(() =>
      serviceWith({ SCREEN_CAPTURE_INTERVAL: "Infinity" }),
    ).toThrow();
  });
});
