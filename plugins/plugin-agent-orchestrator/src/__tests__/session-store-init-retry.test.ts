import { describe, expect, it } from "vitest";
import { AcpSessionStore } from "../services/session-store.js";

describe("RuntimeDbSessionStore schema init", () => {
  it("retries after a transient failure instead of replaying the cached rejection", async () => {
    let failuresLeft = 1;
    let ddlAttempts = 0;
    const adapter = {
      async execute(sql: string) {
        if (sql.trimStart().startsWith("CREATE TABLE")) {
          ddlAttempts += 1;
          if (failuresLeft > 0) {
            failuresLeft -= 1;
            throw new Error("database is locked mid-recovery");
          }
        }
      },
      async all() {
        return [];
      },
    };
    const warns: string[] = [];
    const store = new AcpSessionStore({
      runtime: {
        adapter,
        logger: { warn: (message: string) => warns.push(message) },
      } as never,
    });
    expect(store.backend).toBe("runtime-db");

    await expect(store.list()).rejects.toThrow(/locked mid-recovery/);
    expect(warns.join("\n")).toContain("locked mid-recovery");

    await expect(store.list()).resolves.toEqual([]);
    expect(ddlAttempts).toBe(2);
  });
});
