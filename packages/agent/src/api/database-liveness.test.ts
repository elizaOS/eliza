/**
 * Unit coverage for database-liveness probing: adapter-surface priority
 * (raw connection, connection, db, isReady), query-vs-execute handles, and
 * terminal vs transient PGlite error classification including cause chains.
 */

import type { AgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  isTerminalDatabaseLivenessError,
  probeRuntimeDatabaseLiveness,
} from "./database-liveness.ts";

function runtimeWith(adapter: unknown): AgentRuntime {
  return { adapter } as unknown as AgentRuntime;
}

describe("isTerminalDatabaseLivenessError", () => {
  it.each([
    "pglite is closed",
    "PGlite is Closed",
    "database is shutting down",
    "operation rejected",
    "cannot query a closed connection",
    "cannot queryclosed",
    "closed database",
  ])("classifies %s as terminal", (message) => {
    expect(isTerminalDatabaseLivenessError(new Error(message))).toBe(true);
    expect(isTerminalDatabaseLivenessError(message)).toBe(true);
  });

  it("walks Error.cause until a terminal pattern matches", () => {
    const terminal = new Error("pglite is closed");
    const mid = new Error("query failed", { cause: terminal });
    const outer = new Error("adapter boom", { cause: mid });
    expect(isTerminalDatabaseLivenessError(outer)).toBe(true);
  });

  it("walks a non-Error object's cause chain", () => {
    expect(
      isTerminalDatabaseLivenessError({
        cause: { cause: "database is shutting down" },
      }),
    ).toBe(true);
    expect(
      isTerminalDatabaseLivenessError({
        cause: new Error("closed database"),
      }),
    ).toBe(true);
  });

  it("does not treat a plain object's message field as the probe error", () => {
    expect(
      isTerminalDatabaseLivenessError({ message: "pglite is closed" }),
    ).toBe(false);
  });

  it("returns false for non-matching and empty input", () => {
    expect(isTerminalDatabaseLivenessError(null)).toBe(false);
    expect(isTerminalDatabaseLivenessError(undefined)).toBe(false);
    expect(isTerminalDatabaseLivenessError("")).toBe(false);
    expect(isTerminalDatabaseLivenessError(0)).toBe(false);
    expect(isTerminalDatabaseLivenessError({})).toBe(false);
    expect(
      isTerminalDatabaseLivenessError(new Error("temporary network timeout")),
    ).toBe(false);
  });

  it("does not hang on a circular cause chain", () => {
    const cyclic: { cause?: unknown } = {};
    cyclic.cause = cyclic;
    expect(isTerminalDatabaseLivenessError(cyclic)).toBe(false);

    const err = new Error("transient");
    (err as Error & { cause: unknown }).cause = err;
    expect(isTerminalDatabaseLivenessError(err)).toBe(false);
  });
});

describe("probeRuntimeDatabaseLiveness", () => {
  it("reports unknown and not-ok when no runtime is present", async () => {
    await expect(probeRuntimeDatabaseLiveness(null)).resolves.toEqual({
      status: "unknown",
      ok: false,
      terminal: false,
    });
  });

  it("reports unknown but ok when the runtime has no adapter object", async () => {
    await expect(
      probeRuntimeDatabaseLiveness(runtimeWith(null)),
    ).resolves.toEqual({
      status: "unknown",
      ok: true,
      terminal: false,
    });
    await expect(
      probeRuntimeDatabaseLiveness(runtimeWith(undefined)),
    ).resolves.toEqual({
      status: "unknown",
      ok: true,
      terminal: false,
    });
    await expect(
      probeRuntimeDatabaseLiveness(runtimeWith("not-an-adapter")),
    ).resolves.toEqual({
      status: "unknown",
      ok: true,
      terminal: false,
    });
  });

  it("probes getRawConnection via query('SELECT 1')", async () => {
    const queries: string[] = [];
    const result = await probeRuntimeDatabaseLiveness(
      runtimeWith({
        getRawConnection: () => ({
          query: async (sql: string) => {
            queries.push(sql);
          },
        }),
      }),
    );
    expect(result).toEqual({ status: "ok", ok: true, terminal: false });
    expect(queries).toEqual(["SELECT 1"]);
  });

  it("probes a handle that only exposes execute", async () => {
    let executeCalls = 0;
    const result = await probeRuntimeDatabaseLiveness(
      runtimeWith({
        getRawConnection: () => ({
          execute: async () => {
            executeCalls += 1;
          },
        }),
      }),
    );
    expect(result).toEqual({ status: "ok", ok: true, terminal: false });
    expect(executeCalls).toBe(1);
  });

  it("prefers query over execute on the same handle", async () => {
    const calls: string[] = [];
    const result = await probeRuntimeDatabaseLiveness(
      runtimeWith({
        getRawConnection: () => ({
          query: async (sql: string) => {
            calls.push(`query:${sql}`);
          },
          execute: async () => {
            calls.push("execute");
          },
        }),
      }),
    );
    expect(result.ok).toBe(true);
    expect(calls).toEqual(["query:SELECT 1"]);
  });

  it("probes getConnection when no raw connection is exposed", async () => {
    const queries: string[] = [];
    const result = await probeRuntimeDatabaseLiveness(
      runtimeWith({
        getConnection: async () => ({
          query: async (sql: string) => {
            queries.push(sql);
          },
        }),
      }),
    );
    expect(result).toEqual({ status: "ok", ok: true, terminal: false });
    expect(queries).toEqual(["SELECT 1"]);
  });

  it("probes adapter.db when no connection getters exist", async () => {
    const queries: string[] = [];
    const result = await probeRuntimeDatabaseLiveness(
      runtimeWith({
        db: {
          query: async (sql: string) => {
            queries.push(sql);
          },
        },
      }),
    );
    expect(result).toEqual({ status: "ok", ok: true, terminal: false });
    expect(queries).toEqual(["SELECT 1"]);
  });

  it("falls back to isReady() when no queryable surface exists", async () => {
    await expect(
      probeRuntimeDatabaseLiveness(
        runtimeWith({
          isReady: async () => true,
        }),
      ),
    ).resolves.toEqual({ status: "ok", ok: true, terminal: false });
  });

  it("treats isReady() false as a transient probe failure", async () => {
    await expect(
      probeRuntimeDatabaseLiveness(
        runtimeWith({
          isReady: async () => false,
        }),
      ),
    ).resolves.toEqual({
      status: "transient_error",
      ok: false,
      terminal: false,
      message: "adapter.isReady() returned false",
    });
  });

  it("fails closed when the adapter exposes no probe surface", async () => {
    await expect(
      probeRuntimeDatabaseLiveness(runtimeWith({})),
    ).resolves.toEqual({
      status: "transient_error",
      ok: false,
      terminal: false,
      message: "database adapter exposes no liveness probe surface",
    });
  });

  it("fails closed when the handle has neither query nor execute", async () => {
    await expect(
      probeRuntimeDatabaseLiveness(
        runtimeWith({
          getRawConnection: () => ({}),
        }),
      ),
    ).resolves.toMatchObject({
      status: "transient_error",
      ok: false,
      terminal: false,
      message: "database connection does not expose query or execute",
    });
    await expect(
      probeRuntimeDatabaseLiveness(
        runtimeWith({
          getRawConnection: () => null,
        }),
      ),
    ).resolves.toMatchObject({
      message: "database connection does not expose query or execute",
    });
    await expect(
      probeRuntimeDatabaseLiveness(
        runtimeWith({
          getRawConnection: () => "not-a-handle",
        }),
      ),
    ).resolves.toMatchObject({
      message: "database connection does not expose query or execute",
    });
  });

  it("prefers getRawConnection over getConnection, db, and isReady", async () => {
    const queries: string[] = [];
    const result = await probeRuntimeDatabaseLiveness(
      runtimeWith({
        getRawConnection: () => ({
          query: async (sql: string) => {
            queries.push(sql);
          },
        }),
        getConnection: async () => {
          throw new Error("getConnection must not run");
        },
        db: {
          query: async () => {
            throw new Error("db must not run");
          },
        },
        isReady: async () => {
          throw new Error("isReady must not run");
        },
      }),
    );
    expect(result.ok).toBe(true);
    expect(queries).toEqual(["SELECT 1"]);
  });

  it("prefers getConnection over db and isReady", async () => {
    const queries: string[] = [];
    const result = await probeRuntimeDatabaseLiveness(
      runtimeWith({
        getConnection: async () => ({
          query: async (sql: string) => {
            queries.push(sql);
          },
        }),
        db: {
          query: async () => {
            throw new Error("db must not run");
          },
        },
        isReady: async () => false,
      }),
    );
    expect(result.ok).toBe(true);
    expect(queries).toEqual(["SELECT 1"]);
  });

  it("prefers adapter.db over isReady", async () => {
    const queries: string[] = [];
    const result = await probeRuntimeDatabaseLiveness(
      runtimeWith({
        db: {
          query: async (sql: string) => {
            queries.push(sql);
          },
        },
        isReady: async () => false,
      }),
    );
    expect(result.ok).toBe(true);
    expect(queries).toEqual(["SELECT 1"]);
  });

  it("skips a falsy adapter.db and falls through to isReady", async () => {
    await expect(
      probeRuntimeDatabaseLiveness(
        runtimeWith({
          db: null,
          isReady: async () => true,
        }),
      ),
    ).resolves.toEqual({ status: "ok", ok: true, terminal: false });
  });

  it("maps a terminal probe exception to terminal_error", async () => {
    await expect(
      probeRuntimeDatabaseLiveness(
        runtimeWith({
          getRawConnection: () => ({
            query: async () => {
              throw new Error("PGlite is closed");
            },
          }),
        }),
      ),
    ).resolves.toEqual({
      status: "terminal_error",
      ok: false,
      terminal: true,
      message: "PGlite is closed",
    });
  });

  it("maps a non-terminal probe exception to transient_error", async () => {
    await expect(
      probeRuntimeDatabaseLiveness(
        runtimeWith({
          getRawConnection: () => ({
            query: async () => {
              throw new Error("temporary network timeout");
            },
          }),
        }),
      ),
    ).resolves.toEqual({
      status: "transient_error",
      ok: false,
      terminal: false,
      message: "temporary network timeout",
    });
  });

  it("classifies a thrown string and a circular throw for the message field", async () => {
    await expect(
      probeRuntimeDatabaseLiveness(
        runtimeWith({
          getRawConnection: () => ({
            query: async () => {
              throw "temporary network timeout";
            },
          }),
        }),
      ),
    ).resolves.toMatchObject({
      status: "transient_error",
      message: "temporary network timeout",
    });

    const circular: { self?: unknown } = {};
    circular.self = circular;
    const circularResult = await probeRuntimeDatabaseLiveness(
      runtimeWith({
        getRawConnection: () => ({
          query: async () => {
            throw circular;
          },
        }),
      }),
    );
    expect(circularResult).toMatchObject({
      status: "transient_error",
      ok: false,
      terminal: false,
    });
    expect(circularResult.message).toBe("[object Object]");
  });

  it("surfaces a rejected getConnection as a transient probe failure", async () => {
    await expect(
      probeRuntimeDatabaseLiveness(
        runtimeWith({
          getConnection: async () => {
            throw new Error("connection pool exhausted");
          },
        }),
      ),
    ).resolves.toEqual({
      status: "transient_error",
      ok: false,
      terminal: false,
      message: "connection pool exhausted",
    });
  });

  it("treats a terminal cause nested under a generic query error as terminal", async () => {
    await expect(
      probeRuntimeDatabaseLiveness(
        runtimeWith({
          getRawConnection: () => ({
            query: async () => {
              throw new Error("query failed", {
                cause: new Error("operation rejected"),
              });
            },
          }),
        }),
      ),
    ).resolves.toEqual({
      status: "terminal_error",
      ok: false,
      terminal: true,
      message: "query failed",
    });
  });
});
