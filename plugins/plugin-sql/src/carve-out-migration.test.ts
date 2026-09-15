/**
 * Behavioral tests for durable carve-out receipts. The stateful SQL boundary
 * models one database ledger and exercises repeated, concurrent, failed, and
 * deletion-after-completion startup without replacing the orchestrator itself.
 */
import { describe, expect, it } from "vitest";
import {
  type CarveOutDatabase,
  type CarveOutSqlExecutor,
  createDrizzleCarveOutDatabase,
  runCarveOutMigration,
} from "./carve-out-migration.js";

function transactionDatabase(exec: CarveOutSqlExecutor): CarveOutDatabase {
  return { execute: exec, transaction: (operation) => operation(exec) };
}

interface Receipt {
  holder: string;
  status: "running" | "completed";
}

function ledgerExecutor() {
  const receipts = new Map<string, Receipt>();
  return async (sql: string): Promise<Array<Record<string, unknown>>> => {
    const quoted = [...sql.matchAll(/'([^']+)'/g)].map((match) => match[1]);
    if (sql.includes("carve-out:claim")) {
      const [key, holder] = quoted;
      if (receipts.has(key)) return [];
      receipts.set(key, { holder, status: "running" });
      return [{ holder_token: holder }];
    }
    if (sql.includes("carve-out:status")) {
      const receipt = receipts.get(quoted[0]);
      return receipt ? [{ status: receipt.status }] : [];
    }
    if (sql.includes("carve-out:complete")) {
      const outcomeIndex = quoted.indexOf("copied");
      const key = quoted[outcomeIndex + 1];
      const holder = quoted[outcomeIndex + 2];
      const receipt = receipts.get(key);
      if (!receipt || receipt.holder !== holder || receipt.status !== "running") return [];
      receipt.status = "completed";
      return [{ migration_key: key }];
    }
    if (sql.includes("carve-out:release")) {
      const [key, holder] = quoted;
      if (receipts.get(key)?.holder === holder) receipts.delete(key);
    }
    return [];
  };
}

describe("runCarveOutMigration", () => {
  it("preserves the Drizzle transaction method receiver", async () => {
    const drizzleDatabase = {
      async execute(): Promise<Array<Record<string, unknown>>> {
        return [];
      },
      async transaction<T>(
        this: unknown,
        operation: (transaction: { execute(query: unknown): Promise<unknown> }) => Promise<T>
      ): Promise<T> {
        expect(this).toBe(drizzleDatabase);
        return operation({ execute: async () => [] });
      },
    };
    const database = await createDrizzleCarveOutDatabase(drizzleDatabase);

    await expect(
      database.transaction(async (execute) => {
        await execute("SELECT 1");
        return "bound";
      })
    ).resolves.toBe("bound");
  });

  it("keeps source locking, copy, and receipt completion on the owned transaction executor", async () => {
    const outside: string[] = [];
    const transactionStatements: string[] = [];
    const database: CarveOutDatabase = {
      execute: async (statement) => {
        outside.push(statement);
        return [];
      },
      transaction: async (operation) =>
        operation(async (statement) => {
          transactionStatements.push(statement);
          if (statement.includes("carve-out:claim")) {
            return [{ holder_token: [...statement.matchAll(/'([^']+)'/g)][1]?.[1] }];
          }
          if (statement.includes("carve-out:complete")) {
            return [{ migration_key: "owned-session/v1" }];
          }
          return [];
        }),
    };

    await runCarveOutMigration(database, {
      key: "owned-session/v1",
      sourceTables: [{ schema: "app_lifeops", table: "source_rows" }],
      run: async (execute) => {
        await execute("/* domain:copy */ INSERT INTO target_rows SELECT * FROM source_rows");
        await execute("/* domain:verify */ SELECT 1");
        return "copied";
      },
      outcome: String,
    });

    expect(outside).toHaveLength(2);
    expect(
      transactionStatements.map((statement) => statement.match(/\/\* ([^*]+) \*\//)?.[1])
    ).toEqual([
      "carve-out:claim",
      "carve-out:lock-sources",
      "domain:copy",
      "domain:verify",
      "carve-out:complete",
    ]);
    expect(
      transactionStatements.some((statement) => /^(BEGIN|COMMIT)\s*;?$/i.test(statement.trim()))
    ).toBe(false);
  });

  it("fails concurrent startup closed until the durable completion is recorded", async () => {
    const exec = ledgerExecutor();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let runs = 0;
    const first = runCarveOutMigration(transactionDatabase(exec), {
      key: "calendar/events/v1",
      sourceTables: [{ schema: "app_lifeops", table: "events" }],
      run: async () => {
        runs += 1;
        await gate;
        return "copied";
      },
      outcome: (value) => value,
    });
    await Promise.resolve();
    await expect(
      runCarveOutMigration(transactionDatabase(exec), {
        key: "calendar/events/v1",
        sourceTables: [{ schema: "app_lifeops", table: "events" }],
        run: async () => {
          runs += 1;
          return "copied";
        },
        outcome: (value) => value,
      })
    ).rejects.toMatchObject({ code: "CARVE_OUT_MIGRATION_IN_PROGRESS" });
    release();
    await expect(first).resolves.toEqual({ status: "completed", value: "copied" });
    expect(runs).toBe(1);
  });

  it("never steals an old running claim because callback duration is unbounded", async () => {
    const exec = async (sql: string): Promise<Array<Record<string, unknown>>> => {
      const quoted = [...sql.matchAll(/'([^']+)'/g)].map((match) => match[1]);
      if (sql.includes("carve-out:claim")) {
        // Model a receipt old enough to satisfy the former timeout takeover.
        // Returning the contender only when the statement attempts an update
        // makes this regression fail if automatic takeover is restored.
        return sql.includes("DO UPDATE") ? [{ holder_token: quoted[1] }] : [];
      }
      if (sql.includes("carve-out:status")) return [{ status: "running" }];
      return [];
    };
    let runs = 0;

    await expect(
      runCarveOutMigration(transactionDatabase(exec), {
        key: "calendar/events/v1",
        sourceTables: [{ schema: "app_lifeops", table: "events" }],
        run: async () => {
          runs += 1;
          return "copied";
        },
        outcome: (value) => value,
      })
    ).rejects.toMatchObject({ code: "CARVE_OUT_MIGRATION_IN_PROGRESS" });
    expect(runs).toBe(0);
  });

  it("fails closed when a rejected claim has no readable receipt", async () => {
    const exec = async (sql: string): Promise<Array<Record<string, unknown>>> => {
      if (sql.includes("carve-out:claim") || sql.includes("carve-out:status")) {
        return [];
      }
      return [];
    };
    await expect(
      runCarveOutMigration(transactionDatabase(exec), {
        key: "calendar/events/v1",
        sourceTables: [{ schema: "app_lifeops", table: "events" }],
        run: async () => "copied",
        outcome: String,
      })
    ).rejects.toMatchObject({ code: "CARVE_OUT_MIGRATION_RECEIPT_INVALID" });
  });

  it("does not rerun after target data is owner-deleted", async () => {
    const exec = ledgerExecutor();
    let targetRows = 1;
    const migrate = () =>
      runCarveOutMigration(transactionDatabase(exec), {
        key: "reminders/plans/v1", // gitleaks:allow synthetic migration receipt identifier
        sourceTables: [{ schema: "app_lifeops", table: "plans" }],
        run: async () => {
          targetRows += 1;
          return "copied";
        },
        outcome: (value) => value,
      });
    await migrate();
    targetRows = 0;
    await expect(migrate()).resolves.toEqual({ status: "already-completed" });
    expect(targetRows).toBe(0);
  });

  it("releases a failed attempt so an idempotent retry can complete", async () => {
    const exec = ledgerExecutor();
    await expect(
      runCarveOutMigration(transactionDatabase(exec), {
        key: "inbox/triage/v1", // gitleaks:allow synthetic migration receipt identifier
        sourceTables: [{ schema: "app_lifeops", table: "triage" }],
        run: async () => {
          throw new Error("partial copy rolled back");
        },
        outcome: String,
      })
    ).rejects.toThrow("partial copy rolled back");
    await expect(
      runCarveOutMigration(transactionDatabase(exec), {
        key: "inbox/triage/v1", // gitleaks:allow synthetic migration receipt identifier
        sourceTables: [{ schema: "app_lifeops", table: "triage" }],
        run: async () => "copied",
        outcome: String,
      })
    ).resolves.toEqual({ status: "completed", value: "copied" });
  });

  it("preserves the migration failure when lease cleanup also fails", async () => {
    const baseExec = ledgerExecutor();
    const exec = async (sql: string) => {
      if (sql.includes("carve-out:release")) {
        throw new Error("database unavailable during cleanup");
      }
      return baseExec(sql);
    };
    await expect(
      runCarveOutMigration(transactionDatabase(exec), {
        key: "goals/items/v1",
        sourceTables: [{ schema: "app_lifeops", table: "items" }],
        run: async () => {
          throw new Error("migration transaction rolled back");
        },
        outcome: String,
      })
    ).rejects.toThrow("migration transaction rolled back");
  });
});
