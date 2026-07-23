/**
 * Source-level contract for the native GlassBridge wallpaper host: both
 * platforms expose the same byte-piped setBackdrop/clearBackdrop surface, and
 * neither contains ANY network or cookie machinery. The wallpaper crosses the
 * bridge as pre-downsampled bytes from the page, so a native-side fetch (and
 * with it the #16656 cookie-disclosure class, where the iOS plugin forwarded
 * the whole WebView cookie jar to arbitrary wallpaper origins) must never
 * reappear. Text-level assertions are deliberate: they gate the *presence of
 * machinery*, which behavior tests on a device lane cannot see when the code
 * path is simply absent.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (relative) =>
  readFileSync(new URL(relative, import.meta.url), "utf8");

const ios = read("../platforms/ios/App/App/GlassBridge.swift");
const android = read(
  "../platforms/android/app/src/main/java/ai/elizaos/app/GlassBridgePlugin.java",
);

describe("native GlassBridge wallpaper contract", () => {
  it("exposes setBackdrop + clearBackdrop on both native plugins", () => {
    expect(ios).toContain('CAPPluginMethod(name: "setBackdrop"');
    expect(ios).toContain('CAPPluginMethod(name: "clearBackdrop"');
    expect(ios).toContain("func setBackdrop(");
    expect(ios).toContain("func clearBackdrop(");
    expect(android).toContain("void setBackdrop(PluginCall call)");
    expect(android).toContain("void clearBackdrop(PluginCall call)");
  });

  it("consumes piped bytes and acknowledges only after decode", () => {
    expect(ios).toContain('call.getString("imageBase64")');
    expect(ios).toContain("Data(base64Encoded: imageBase64)");
    expect(ios).toContain('call.resolve(["applied": true])');
    expect(android).toContain('call.getString("imageBase64")');
    expect(android).toContain("BitmapFactory.decodeByteArray");
    expect(android).toContain("resolveApplied(call, true)");
  });

  it("contains NO network or cookie machinery — bytes only, ever", () => {
    // iOS: no URLSession fetches, no WebView cookie-store reads, no
    // all-cookies header serialization (the exact #16656 P0 shape).
    expect(ios).not.toContain("URLSession");
    expect(ios).not.toContain("httpCookieStore");
    expect(ios).not.toContain("getAllCookies");
    expect(ios).not.toContain("requestHeaderFields");
    // Android: no HTTP connections and no cookie forwarding either — even the
    // URL-scoped CookieManager read is machinery a bytes contract never needs.
    expect(android).not.toContain("HttpURLConnection");
    expect(android).not.toContain("CookieManager");
    expect(android).not.toContain("openConnection");
  });

  it("restores WebView opacity when nothing native remains", () => {
    expect(ios).toContain("restoreWebViewOpacityIfUnneeded");
    expect(android).toContain("restoreWebViewOpacityIfUnneeded");
  });
});
