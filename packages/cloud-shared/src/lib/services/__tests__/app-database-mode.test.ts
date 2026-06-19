import { describe, expect, test } from "bun:test";
import {
  DEFAULT_APP_DATABASE_MODE,
  isAppDatabaseMode,
  resolveAppDatabaseMode,
} from "../app-database-mode";

describe("isAppDatabaseMode", () => {
  test("accepts the two valid modes only", () => {
    expect(isAppDatabaseMode("none")).toBe(true);
    expect(isAppDatabaseMode("isolated")).toBe(true);
    expect(isAppDatabaseMode("shared")).toBe(false);
    expect(isAppDatabaseMode("")).toBe(false);
    expect(isAppDatabaseMode(undefined)).toBe(false);
    expect(isAppDatabaseMode(null)).toBe(false);
    expect(isAppDatabaseMode(1)).toBe(false);
  });
});

describe("resolveAppDatabaseMode", () => {
  test("defaults to 'none' for missing / empty / malformed metadata", () => {
    expect(DEFAULT_APP_DATABASE_MODE).toBe("none");
    expect(resolveAppDatabaseMode(undefined)).toBe("none");
    expect(resolveAppDatabaseMode(null)).toBe("none");
    expect(resolveAppDatabaseMode({})).toBe("none");
    expect(resolveAppDatabaseMode({ databaseMode: "shared" })).toBe("none");
    expect(resolveAppDatabaseMode({ databaseMode: 1 })).toBe("none");
    expect(resolveAppDatabaseMode({ other: "isolated" })).toBe("none");
  });
  test("reads an explicit mode from metadata", () => {
    expect(resolveAppDatabaseMode({ databaseMode: "isolated" })).toBe("isolated");
    expect(resolveAppDatabaseMode({ databaseMode: "none" })).toBe("none");
    // tolerates other metadata keys alongside it (e.g. containerId)
    expect(resolveAppDatabaseMode({ databaseMode: "isolated", containerId: "c-1" })).toBe(
      "isolated",
    );
  });
});
