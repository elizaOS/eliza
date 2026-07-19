import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (relative) =>
  readFileSync(new URL(relative, import.meta.url), "utf8");

const ios = read("../platforms/ios/App/App/GlassBridge.swift");
const android = read(
  "../platforms/android/app/src/main/java/ai/elizaos/app/GlassBridgePlugin.java",
);

describe("native GlassBridge wallpaper contract", () => {
  it("exposes setBackdrop on both native plugins", () => {
    expect(ios).toContain('CAPPluginMethod(name: "setBackdrop"');
    expect(ios).toContain("func setBackdrop(");
    expect(android).toContain("void setBackdrop(PluginCall call)");
  });

  it("acknowledges images only after decode and keeps a solid clear path", () => {
    expect(ios).toContain("UIImage(data: data)");
    expect(ios).toContain('call.resolve(["applied": true])');
    expect(android).toContain("BitmapFactory.decodeStream");
    expect(android).toContain("resolveApplied(call, true)");
    expect(ios).toContain("installBackdrop(image: nil, color: color");
    expect(android).toContain("generation, null, color");
  });

  it("reuses WebView cookies for content-addressed media requests", () => {
    expect(ios).toContain("httpCookieStore.getAllCookies");
    expect(android).toContain("CookieManager.getInstance().getCookie");
  });
});
