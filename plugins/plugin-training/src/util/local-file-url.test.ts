// Exercises local file URL helpers used by training artifacts.
import { describe, expect, it } from "vitest";
import { toLocalFileUrl } from "./local-file-url";

/**
 * `file://${path}` is malformed on Windows: a drive path (`C:\…`) has no leading
 * slash and uses backslashes, so the browser reads `C:` as the URL host and the
 * link fails to open. `toLocalFileUrl` must yield `file:///C:/…` on Windows and
 * `file:///…` on POSIX, and pass through inputs that are already URLs.
 */
describe("toLocalFileUrl", () => {
  it("converts a Windows drive path to a valid file:// URL (C: is NOT the host)", () => {
    const url = toLocalFileUrl("C:\\Users\\me\\report.html");
    expect(url).toBe("file:///C:/Users/me/report.html");
    const parsed = new URL(url);
    expect(parsed.protocol).toBe("file:");
    // The pre-fix bug parsed `C:` as the authority/host — assert it does not.
    expect(parsed.host).toBe("");
    expect(parsed.pathname).toBe("/C:/Users/me/report.html");
  });

  it("converts a POSIX absolute path", () => {
    expect(toLocalFileUrl("/home/me/report.html")).toBe(
      "file:///home/me/report.html",
    );
  });

  it("percent-encodes spaces and reserved chars in the path", () => {
    expect(toLocalFileUrl("C:\\my reports\\a b.html")).toBe(
      "file:///C:/my%20reports/a%20b.html",
    );
    expect(toLocalFileUrl("/tmp/a b.json")).toBe("file:///tmp/a%20b.json");
  });

  it("normalizes mixed/back slashes", () => {
    expect(toLocalFileUrl("C:/Users\\me/x.html")).toBe(
      "file:///C:/Users/me/x.html",
    );
  });

  it("passes an existing http(s)/file/blob/data URL through unchanged", () => {
    expect(toLocalFileUrl("https://example.com/a")).toBe(
      "https://example.com/a",
    );
    expect(toLocalFileUrl("http://x/y")).toBe("http://x/y");
    expect(toLocalFileUrl("file:///already/there")).toBe(
      "file:///already/there",
    );
  });

  it("roots a bare relative path under file:// (no crash on unexpected input)", () => {
    expect(toLocalFileUrl("report.html")).toBe("file:///report.html");
  });
});
