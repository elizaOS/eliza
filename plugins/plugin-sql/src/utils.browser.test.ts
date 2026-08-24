/**
 * Tests for `utils.browser` — the browser build of the SQL plugin's path
 * utilities.
 *
 * Core contract: in the browser there is no filesystem, so the three path
 * helpers must stay fixed-value stubs (identity / constants). If someone
 * wires the node implementation into the browser bundle, `node:fs` breaks
 * the build — this pins the stub behavior so the divergence cannot be
 * reverted silently. The shared json sanitizer must remain re-exported so
 * the three platform builds (node / browser / shared) cannot drift.
 */

import { describe, expect, it } from "vitest";
import {
  expandTildePath,
  MAX_SQL_JSON_SANITIZE_DEPTH,
  MAX_SQL_JSON_SANITIZE_NODES,
  resolveEnvFile,
  resolvePgliteDir,
  sanitizeJsonObject,
} from "./utils.browser";

describe("expandTildePath (browser build)", () => {
  it("is an identity — no filesystem expansion in the browser", () => {
    expect(expandTildePath("~/data/db.sqlite")).toBe("~/data/db.sqlite");
    expect(expandTildePath("/absolute/path.sqlite")).toBe("/absolute/path.sqlite");
    expect(expandTildePath("")).toBe("");
  });
});

describe("resolveEnvFile (browser build)", () => {
  it("always returns the fixed .env name regardless of start dir", () => {
    expect(resolveEnvFile()).toBe(".env");
    expect(resolveEnvFile("/some/start/dir")).toBe(".env");
    expect(resolveEnvFile(undefined)).toBe(".env");
  });
});

describe("resolvePgliteDir (browser build)", () => {
  it("always resolves to the in-memory backend in the browser", () => {
    expect(resolvePgliteDir()).toBe("in-memory");
    expect(resolvePgliteDir("/tmp/ignored")).toBe("in-memory");
    expect(resolvePgliteDir(undefined, "/fallback")).toBe("in-memory");
  });
});

describe("shared json sanitizer re-export", () => {
  it("re-exports the sanitize function so platform builds cannot drift", () => {
    expect(typeof sanitizeJsonObject).toBe("function");
  });

  it("re-exports the structural budget constants", () => {
    expect(MAX_SQL_JSON_SANITIZE_DEPTH).toBe(64);
    expect(MAX_SQL_JSON_SANITIZE_NODES).toBe(10_000);
  });

  it("sanitizeJsonObject still strips NULs through the browser entry", () => {
    const out = sanitizeJsonObject({ note: "a\u0000b" });
    expect(JSON.stringify(out)).not.toContain("\\u0000");
    expect(out).toEqual({ note: "ab" });
  });
});
