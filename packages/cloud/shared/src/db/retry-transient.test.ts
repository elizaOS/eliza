// Exercises cloud DB retry transient behavior with deterministic repository fixtures.
import { describe, expect, it } from "vitest";
import { isTransientDbError, retryOnTransientDbError } from "./retry-transient";

const pgError = (code: string, message = "boom") => Object.assign(new Error(message), { code });

describe("isTransientDbError", () => {
  it("classifies connection-class SQLSTATEs as transient", () => {
    expect(isTransientDbError(pgError("08006"))).toBe(true);
    expect(isTransientDbError(pgError("57P01"))).toBe(true);
    expect(isTransientDbError(pgError("53300"))).toBe(true);
  });

  it("classifies node socket error codes as transient", () => {
    expect(isTransientDbError(pgError("ECONNRESET"))).toBe(true);
    expect(isTransientDbError(pgError("ETIMEDOUT"))).toBe(true);
  });

  it("classifies connection-failure messages as transient", () => {
    expect(isTransientDbError(new Error("Connection terminated unexpectedly"))).toBe(true);
    expect(
      isTransientDbError(
        new Error("could not accept SSL connection: unexpected eof while reading"),
      ),
    ).toBe(true);
  });

  it("walks the cause chain", () => {
    const wrapped = Object.assign(new Error("query failed"), { cause: pgError("08006") });
    expect(isTransientDbError(wrapped)).toBe(true);
  });

  it("does NOT classify query/constraint errors as transient", () => {
    expect(isTransientDbError(pgError("23505", "duplicate key"))).toBe(false); // unique_violation
    expect(isTransientDbError(pgError("42P01", "relation does not exist"))).toBe(false);
    expect(isTransientDbError(new Error("syntax error"))).toBe(false);
    expect(isTransientDbError(undefined)).toBe(false);
    expect(isTransientDbError("nope")).toBe(false);
  });
});

describe("retryOnTransientDbError", () => {
  const noSleep = async () => {};

  it("returns immediately on success without retrying", async () => {
    let calls = 0;
    const result = await retryOnTransientDbError(
      async () => {
        calls++;
        return "ok";
      },
      { sleep: noSleep },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(1);
  });

  it("retries transient errors and succeeds within the attempt budget", async () => {
    let calls = 0;
    const result = await retryOnTransientDbError(
      async () => {
        calls++;
        if (calls < 3) throw pgError("08006", "Connection terminated unexpectedly");
        return "recovered";
      },
      { attempts: 3, sleep: noSleep },
    );
    expect(result).toBe("recovered");
    expect(calls).toBe(3);
  });

  it("does NOT retry non-transient errors", async () => {
    let calls = 0;
    await expect(
      retryOnTransientDbError(
        async () => {
          calls++;
          throw pgError("23505", "duplicate key");
        },
        { attempts: 5, sleep: noSleep },
      ),
    ).rejects.toMatchObject({ code: "23505" });
    expect(calls).toBe(1);
  });

  it("rethrows the last error after exhausting attempts", async () => {
    let calls = 0;
    await expect(
      retryOnTransientDbError(
        async () => {
          calls++;
          throw pgError("08006", "down");
        },
        { attempts: 3, sleep: noSleep },
      ),
    ).rejects.toMatchObject({ code: "08006" });
    expect(calls).toBe(3);
  });
});
