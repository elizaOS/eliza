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
    expect(android).toContain("settleApplied(call, true)");
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

  it("bounds the byte boundary BEFORE allocation on both platforms", () => {
    // setBackdrop is externally callable: encoded length is checked before
    // base64 decode, and pixel dimensions come from image METADATA before the
    // full bitmap allocation a decompression bomb relies on.
    expect(ios).toContain("maxBackdropEncodedChars");
    expect(ios).toContain("maxBackdropPixels");
    expect(ios).toContain("CGImageSourceCopyPropertiesAtIndex");
    expect(android).toContain("MAX_BACKDROP_ENCODED_CHARS");
    expect(android).toContain("MAX_BACKDROP_PIXELS");
    expect(android).toContain("inJustDecodeBounds");
  });

  it("exposes an idempotent reset for renderer-reload teardown", () => {
    // Native regions/backdrop outlive the document; each fresh renderer
    // resets the host at boot so stale views never survive a reload.
    expect(ios).toContain('CAPPluginMethod(name: "reset"');
    expect(ios).toContain("func reset(");
    expect(android).toContain("void reset(PluginCall call)");
  });

  it("ties the Android decoder executor to the plugin lifecycle", () => {
    // The single-thread decoder must not outlive the Activity, and every
    // in-flight backdrop call settles exactly once even through teardown.
    expect(android).toContain("void handleOnDestroy()");
    expect(android).toContain("shutdownNow");
    expect(android).toContain("RejectedExecutionException");
    expect(android).toContain("pendingBackdropCalls");
  });

  it("settles every iOS call even on plugin deallocation", () => {
    // A `guard let self else { return }` that drops the CAPPluginCall leaves
    // the JS promise hung forever; the bare-return form is banned.
    expect(ios).not.toMatch(/guard let self else \{ return \}/);
  });
});
