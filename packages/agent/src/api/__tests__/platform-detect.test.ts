import { describe, expect, it } from "vitest";
import {
  detectClientPlatform,
  isDynamicLoadingAllowed,
} from "../platform-detect.ts";

function req(headers: Record<string, string | string[] | undefined>) {
  return { headers } as never;
}

describe("detectClientPlatform", () => {
  it("detects from the X-Eliza-Platform header", () => {
    expect(detectClientPlatform(req({ "x-eliza-platform": "ios" }))).toBe(
      "ios",
    );
    expect(detectClientPlatform(req({ "x-eliza-platform": "android" }))).toBe(
      "android",
    );
  });

  it("prefers X-Eliza-Platform over a conflicting User-Agent", () => {
    expect(
      detectClientPlatform(
        req({
          "x-eliza-platform": "ios",
          "user-agent": "Electrobun/1.0",
        }),
      ),
    ).toBe("ios");
    expect(
      detectClientPlatform(
        req({
          "x-eliza-platform": "android",
          "user-agent": "Capacitor...iOS App",
        }),
      ),
    ).toBe("android");
  });

  it("falls through to User-Agent when the platform header is not ios or android", () => {
    expect(
      detectClientPlatform(
        req({
          "x-eliza-platform": "web",
          "user-agent": "Electrobun/1.0",
        }),
      ),
    ).toBe("desktop");
    expect(
      detectClientPlatform(
        req({
          "x-eliza-platform": "desktop",
          "user-agent": "Capacitor...iOS App",
        }),
      ),
    ).toBe("ios");
    expect(
      detectClientPlatform(
        req({
          "x-eliza-platform": "IOS",
          "user-agent": "curl/8",
        }),
      ),
    ).toBe("web");
    expect(detectClientPlatform(req({ "x-eliza-platform": "iOS" }))).toBe(
      "web",
    );
    expect(detectClientPlatform(req({ "x-eliza-platform": "" }))).toBe("web");
  });

  it("ignores array-valued X-Eliza-Platform headers", () => {
    expect(
      detectClientPlatform(
        req({
          "x-eliza-platform": ["ios"],
          "user-agent": "Electrobun/1.0",
        }),
      ),
    ).toBe("desktop");
  });

  it("detects from Capacitor user agents", () => {
    expect(
      detectClientPlatform(req({ "user-agent": "Capacitor...iOS App" })),
    ).toBe("ios");
    expect(
      detectClientPlatform(req({ "user-agent": "Capacitor...Android App" })),
    ).toBe("android");
  });

  it("treats Capacitor User-Agent matches as case-insensitive", () => {
    expect(
      detectClientPlatform(req({ "user-agent": "capacitor/7.0 ios" })),
    ).toBe("ios");
    expect(
      detectClientPlatform(req({ "user-agent": "CAPACITOR Android" })),
    ).toBe("android");
  });

  it("does not treat iOS or Android markers without Capacitor as native shells", () => {
    expect(
      detectClientPlatform(
        req({ "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)" }),
      ),
    ).toBe("web");
    expect(
      detectClientPlatform(
        req({ "user-agent": "Mozilla/5.0 (Linux; Android 14)" }),
      ),
    ).toBe("web");
    expect(detectClientPlatform(req({ "user-agent": "Capacitor App" }))).toBe(
      "web",
    );
  });

  it("prefers Capacitor iOS over Android when both tokens appear", () => {
    expect(
      detectClientPlatform(req({ "user-agent": "Capacitor iOS Android" })),
    ).toBe("ios");
  });

  it("detects Electrobun desktop", () => {
    expect(detectClientPlatform(req({ "user-agent": "Electrobun/1.0" }))).toBe(
      "desktop",
    );
  });

  it("detects Electrobun case-insensitively after Capacitor misses", () => {
    expect(detectClientPlatform(req({ "user-agent": "electrobun" }))).toBe(
      "desktop",
    );
    expect(detectClientPlatform(req({ "user-agent": "ELECTROBUN/2" }))).toBe(
      "desktop",
    );
    expect(
      detectClientPlatform(req({ "user-agent": "Capacitor Electrobun" })),
    ).toBe("desktop");
  });

  it("defaults to web", () => {
    expect(detectClientPlatform(req({}))).toBe("web");
    expect(detectClientPlatform(req({ "user-agent": "curl/8" }))).toBe("web");
  });

  it("treats a missing User-Agent the same as an empty string", () => {
    expect(detectClientPlatform(req({ "user-agent": undefined }))).toBe("web");
    expect(detectClientPlatform(req({ "user-agent": "" }))).toBe("web");
  });
});

describe("isDynamicLoadingAllowed", () => {
  it("blocks store platforms, allows others", () => {
    expect(isDynamicLoadingAllowed("ios")).toBe(false);
    expect(isDynamicLoadingAllowed("android")).toBe(false);
    expect(isDynamicLoadingAllowed("web")).toBe(true);
    expect(isDynamicLoadingAllowed("desktop")).toBe(true);
  });

  it("agrees with detectClientPlatform for store shells versus web and desktop", () => {
    expect(
      isDynamicLoadingAllowed(
        detectClientPlatform(req({ "x-eliza-platform": "ios" })),
      ),
    ).toBe(false);
    expect(
      isDynamicLoadingAllowed(
        detectClientPlatform(req({ "x-eliza-platform": "android" })),
      ),
    ).toBe(false);
    expect(isDynamicLoadingAllowed(detectClientPlatform(req({})))).toBe(true);
    expect(
      isDynamicLoadingAllowed(
        detectClientPlatform(req({ "user-agent": "Electrobun/1.0" })),
      ),
    ).toBe(true);
  });
});
