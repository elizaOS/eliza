/**
 * Unit coverage for the Release Center pure helpers: `summarizeError`
 * (message extraction from unknown throwables), `normalizeReleaseNotesUrl`
 * (validated URL with GitHub-releases fallback), and `partitionDescription`
 * (localized label for desktop session partitions). No React; deterministic
 * node-environment vitest against the real module.
 */
import { EXTERNAL_URLS } from "@elizaos/shared/brand";
import { describe, expect, it } from "vitest";
import {
  normalizeReleaseNotesUrl,
  partitionDescription,
  summarizeError,
} from "./shared.helpers";

const DEFAULT_RELEASE_NOTES_URL = `${EXTERNAL_URLS.github}/releases`;

describe("summarizeError", () => {
  it("extracts the message from an Error instance", () => {
    expect(summarizeError(new Error("release fetch failed"))).toBe(
      "release fetch failed",
    );
  });

  it("stringifies a non-Error thrown value", () => {
    expect(summarizeError("plain string rejection")).toBe(
      "plain string rejection",
    );
    expect(summarizeError(404)).toBe("404");
  });

  it("preserves the message of an Error subclass with empty message", () => {
    class ReleaseError extends Error {}
    const error = new ReleaseError("");
    expect(summarizeError(error)).toBe("");
  });

  it("uses String() semantics for objects, not [object Object] guessing", () => {
    // String({}) is "[object Object]" — the helper must match String(), so a
    // payload carrying toString round-trips its custom representation.
    const payload = { toString: () => "custom failure text" };
    expect(summarizeError(payload)).toBe("custom failure text");
  });

  it("keeps a thrown null distinct from the string 'null' only by type", () => {
    // String(null) === "null": the helper surfaces the raw value truthfully
    // rather than substituting a generic placeholder.
    expect(summarizeError(null)).toBe("null");
    expect(summarizeError(undefined)).toBe("undefined");
  });
});

describe("normalizeReleaseNotesUrl", () => {
  it("returns a valid absolute URL unchanged modulo URL normalization", () => {
    expect(normalizeReleaseNotesUrl("https://example.com/notes")).toBe(
      "https://example.com/notes",
    );
  });

  it("normalizes a whitespace-wrapped URL back to the bare form", () => {
    // Observable contract: surrounding whitespace never leaks into the
    // normalized value.
    expect(normalizeReleaseNotesUrl("  https://example.com/notes  ")).toBe(
      "https://example.com/notes",
    );
  });

  it("falls back to the GitHub releases page for an unparseable value", () => {
    expect(normalizeReleaseNotesUrl("not a url")).toBe(
      DEFAULT_RELEASE_NOTES_URL,
    );
  });

  it("falls back for empty, whitespace-only, null, and undefined inputs", () => {
    expect(normalizeReleaseNotesUrl("")).toBe(DEFAULT_RELEASE_NOTES_URL);
    expect(normalizeReleaseNotesUrl("   ")).toBe(DEFAULT_RELEASE_NOTES_URL);
    expect(normalizeReleaseNotesUrl(null)).toBe(DEFAULT_RELEASE_NOTES_URL);
    expect(normalizeReleaseNotesUrl(undefined)).toBe(DEFAULT_RELEASE_NOTES_URL);
  });

  it("accepts any URL the WHATWG parser accepts, adding a trailing slash for bare hosts", () => {
    // new URL("example.com") throws (no scheme), so it must fall back;
    // a scheme-qualified bare host normalizes with a trailing slash.
    expect(normalizeReleaseNotesUrl("example.com")).toBe(
      DEFAULT_RELEASE_NOTES_URL,
    );
    expect(normalizeReleaseNotesUrl("https://example.com")).toBe(
      "https://example.com/",
    );
  });
});

describe("partitionDescription", () => {
  it("labels the default renderer session via the default partition key", () => {
    const calls: string[] = [];
    const t = (key: string, options?: Record<string, unknown>) => {
      calls.push(key);
      return options?.defaultValue as string;
    };
    expect(partitionDescription("persist:default", t)).toBe(
      "Renderer default session",
    );
    expect(calls).toEqual(["releasecenter.RendererDefaultSession"]);
  });

  it("labels every non-default partition as a sandboxed session", () => {
    const calls: string[] = [];
    const t = (_key: string, options?: Record<string, unknown>) => {
      calls.push(_key);
      return options?.defaultValue as string;
    };
    expect(partitionDescription("persist:release-notes-1.2.3", t)).toBe(
      "Sandboxed release notes session",
    );
    expect(partitionDescription("", t)).toBe("Sandboxed release notes session");
    expect(calls).toEqual([
      "releasecenter.SandboxedReleaseNotesSession",
      "releasecenter.SandboxedReleaseNotesSession",
    ]);
  });

  it("passes the defaultValue option so a missing translation degrades visibly, not silently", () => {
    const seen: Array<Record<string, unknown> | undefined> = [];
    const t = (_key: string, options?: Record<string, unknown>) => {
      seen.push(options);
      return "translated";
    };
    expect(partitionDescription("persist:default", t)).toBe("translated");
    expect(partitionDescription("other", t)).toBe("translated");
    expect(seen[0]).toMatchObject({ defaultValue: "Renderer default session" });
    expect(seen[1]).toMatchObject({
      defaultValue: "Sandboxed release notes session",
    });
  });
});
