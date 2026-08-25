/**
 * Coverage for platform detection.
 */
import { describe, expect, it } from "vitest";

import {
  detectClientPlatform,
  isDynamicLoadingAllowed,
} from "./platform-detect.js";

function req(headers: Record<string, string>): never {
  return { headers } as never;
}

describe("detectClientPlatform", () => {
  it("detects via x-eliza-platform header", () => {
    expect(detectClientPlatform(req({ "x-eliza-platform": "ios" }))).toBe(
      "ios",
    );
    expect(detectClientPlatform(req({ "x-eliza-platform": "android" }))).toBe(
      "android",
    );
  });

  it("detects via Capacitor user-agent", () => {
    expect(
      detectClientPlatform(req({ "user-agent": "Capacitor iOS something" })),
    ).toBe("ios");
    expect(
      detectClientPlatform(req({ "user-agent": "Capacitor Android" })),
    ).toBe("android");
  });

  it("detects Electrobun desktop", () => {
    expect(detectClientPlatform(req({ "user-agent": "Electrobun/1.0" }))).toBe(
      "desktop",
    );
  });

  it("defaults to web", () => {
    expect(detectClientPlatform(req({}))).toBe("web");
    expect(detectClientPlatform(req({ "user-agent": "Mozilla/5.0" }))).toBe(
      "web",
    );
  });

  it("prefers header over ua", () => {
    expect(
      detectClientPlatform(
        req({ "x-eliza-platform": "ios", "user-agent": "Electrobun" }),
      ),
    ).toBe("ios");
  });
});

describe("isDynamicLoadingAllowed", () => {
  it("allows web and desktop", () => {
    expect(isDynamicLoadingAllowed("web")).toBe(true);
    expect(isDynamicLoadingAllowed("desktop")).toBe(true);
  });

  it("blocks ios and android", () => {
    expect(isDynamicLoadingAllowed("ios")).toBe(false);
    expect(isDynamicLoadingAllowed("android")).toBe(false);
  });
});
