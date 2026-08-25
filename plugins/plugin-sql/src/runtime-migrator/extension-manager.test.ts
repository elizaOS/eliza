import { beforeEach, describe, expect, it, vi } from "vitest";

const { sql } = vi.hoisted(() => {
  const sqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings,
    values,
  });
  sqlTag.identifier = (name: string) => ({ identifier: name });
  return { sql: sqlTag };
});

vi.mock("drizzle-orm", () => ({ sql }));

import { ExtensionManager } from "./extension-manager";

function createFakeDb() {
  return { execute: vi.fn().mockResolvedValue(undefined) };
}

describe("ExtensionManager", () => {
  let db: ReturnType<typeof createFakeDb>;

  beforeEach(() => {
    db = createFakeDb();
  });

  it("installs every allowlisted extension name", async () => {
    const manager = new ExtensionManager(db as never);
    await manager.installRequiredExtensions(["vector", "pg_trgm", "fuzzystrmatch", "ext_1-2"]);
    expect(db.execute).toHaveBeenCalledTimes(4);
    for (const call of db.execute.mock.calls) {
      const [arg] = call;
      const identifier = (arg as { strings: string[]; values: unknown[] }).values[0];
      expect(identifier).toMatchObject({ identifier: expect.any(String) });
      expect((identifier as { identifier: string }).identifier).toMatch(/^[a-zA-Z0-9_-]+$/);
    }
  });

  it("skips invalid extension names and never hands them to the database", async () => {
    const manager = new ExtensionManager(db as never);
    await manager.installRequiredExtensions([
      "vector",
      "vector; DROP TABLE users",
      "vec tor",
      "x'y",
      "",
      "pg_trgm",
    ]);
    expect(db.execute).toHaveBeenCalledTimes(2);
    for (const call of db.execute.mock.calls) {
      const [arg] = call;
      const identifier = (arg as { strings: string[]; values: unknown[] }).values[0];
      expect((identifier as { identifier: string }).identifier).not.toMatch(/[^a-zA-Z0-9_-]/);
    }
  });

  it("interpolates the validated name into the CREATE EXTENSION statement", async () => {
    const manager = new ExtensionManager(db as never);
    await manager.installRequiredExtensions(["vector"]);
    const [arg] = db.execute.mock.calls[0];
    const { strings, values } = arg as {
      strings: string[];
      values: unknown[];
    };
    expect(strings.join("${}")).toContain("CREATE EXTENSION IF NOT EXISTS");
    expect(values[0]).toMatchObject({ identifier: "vector" });
  });

  it("continues with remaining extensions when one install fails", async () => {
    db.execute.mockRejectedValueOnce(new Error("extension unavailable"));
    const manager = new ExtensionManager(db as never);
    await expect(manager.installRequiredExtensions(["vector", "pg_trgm"])).resolves.toBeUndefined();
    expect(db.execute).toHaveBeenCalledTimes(2);
  });

  it("fails only the failing extension when several are installed", async () => {
    db.execute.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(undefined);
    const manager = new ExtensionManager(db as never);
    await manager.installRequiredExtensions(["bad_ok", "good"]);
    expect(db.execute).toHaveBeenCalledTimes(2);
  });
});
