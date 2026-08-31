/**
 * Behavioral tests for durable carve-out receipts. The stateful SQL boundary
 * models one database ledger and exercises repeated, concurrent, failed, and
 * deletion-after-completion startup without replacing the orchestrator itself.
 */
import { describe, expect, it } from "vitest";
import { runCarveOutMigration } from "./carve-out-migration.js";

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
  it("serializes concurrent startup and records one durable completion", async () => {
    const exec = ledgerExecutor();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let runs = 0;
    const first = runCarveOutMigration(exec, {
      key: "calendar/events/v1",
      run: async () => {
        runs += 1;
        await gate;
        return "copied";
      },
      outcome: (value) => value,
    });
    await Promise.resolve();
    const second = await runCarveOutMigration(exec, {
      key: "calendar/events/v1",
      run: async () => {
        runs += 1;
        return "copied";
      },
      outcome: (value) => value,
    });
    expect(second).toEqual({ status: "in-progress" });
    release();
    await expect(first).resolves.toEqual({ status: "completed", value: "copied" });
    expect(runs).toBe(1);
  });

  it("does not rerun after target data is owner-deleted", async () => {
    const exec = ledgerExecutor();
    let targetRows = 1;
    const migrate = () =>
      runCarveOutMigration(exec, {
        key: "reminders/plans/v1", // gitleaks:allow synthetic migration receipt identifier
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
      runCarveOutMigration(exec, {
        key: "inbox/triage/v1", // gitleaks:allow synthetic migration receipt identifier
        run: async () => {
          throw new Error("partial copy rolled back");
        },
        outcome: String,
      })
    ).rejects.toThrow("partial copy rolled back");
    await expect(
      runCarveOutMigration(exec, {
        key: "inbox/triage/v1", // gitleaks:allow synthetic migration receipt identifier
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
      runCarveOutMigration(exec, {
        key: "goals/items/v1",
        run: async () => {
          throw new Error("migration transaction rolled back");
        },
        outcome: String,
      })
    ).rejects.toThrow("migration transaction rolled back");
  });
});
