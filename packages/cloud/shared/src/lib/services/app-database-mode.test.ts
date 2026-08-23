/**
 * Coverage for app database mode.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_APP_DATABASE_MODE,
  isAppDatabaseMode,
  resolveAppDatabaseMode,
} from "./app-database-mode.js";

describe("isAppDatabaseMode", () => {
  it("accepts none and isolated", () => {
    expect(isAppDatabaseMode("none")).toBe(true);
    expect(isAppDatabaseMode("isolated")).toBe(true);
  });

  it("rejects others", () => {
    expect(isAppDatabaseMode("other")).toBe(false);
    expect(isAppDatabaseMode("")).toBe(false);
    expect(isAppDatabaseMode(null)).toBe(false);
  });
});

describe("resolveAppDatabaseMode", () => {
  it("returns isolated when set", () => {
    expect(resolveAppDatabaseMode({ databaseMode: "isolated" })).toBe("isolated");
  });

  it("defaults to none for missing", () => {
    expect(resolveAppDatabaseMode({})).toBe("none");
    expect(resolveAppDatabaseMode(null)).toBe("none");
    expect(resolveAppDatabaseMode(undefined)).toBe("none");
  });

  it("defaults for invalid", () => {
    expect(resolveAppDatabaseMode({ databaseMode: "weird" })).toBe("none");
  });

  it("exposes default", () => {
    expect(DEFAULT_APP_DATABASE_MODE).toBe("none");
  });
});
