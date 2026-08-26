import { describe, expect, it, vi } from "vitest";
import { applyMembershipAuthorityTtlConstraints } from "./membership-authority-ttl-constraints.ts";

function makeDb(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  let callIndex = 0;
  const execute = vi.fn(async () => {
    const text = `call-${callIndex++}`;
    calls.push(text);
    if (text === "call-0") {
      // 第一次调用：tables 检查
      return {
        rows: [
          { table_name: "membership_authority_scopes" },
          { table_name: "membership_authority" },
        ],
      };
    }
    if (text === "call-1") {
      // 第二次调用：advisory lock（无返回）
      return { rows: [] };
    }
    if (text === "call-2") {
      // 第三次调用：pg_constraint 检查——默认约束已存在
      const constraints = overrides.constraints ?? [
        { conname: "membership_authority_scope_current_check" },
        { conname: "membership_authority_version_check" },
      ];
      return { rows: constraints };
    }
    return { rows: [] };
  });
  const transaction = async (fn: (tx: { execute: typeof execute }) => Promise<void>) => {
    await fn({ execute });
  };
  return { db: { execute, transaction }, calls };
}

describe("applyMembershipAuthorityTtlConstraints", () => {
  it("skips DDL when both constraints already exist (idempotent restart)", async () => {
    const { db, calls } = makeDb();
    const result = await applyMembershipAuthorityTtlConstraints(db as never);
    expect(result).toBe(true);
    // 幂等路径：tables 检查 + advisory lock + pg_constraint 检查 = 3 次
    // 无 UPDATE / ALTER TABLE
    expect(calls).toHaveLength(3);
  });

  it("runs the DDL when constraints are missing (first boot)", async () => {
    const { db, calls } = makeDb({ constraints: [] });
    const result = await applyMembershipAuthorityTtlConstraints(db as never);
    expect(result).toBe(true);
    // 幂等路径跳过时只有 3 次调用；DDL 路径有更多（advisory + pg_constraint + UPDATE×2 + DDL×4）
    expect(calls.length).toBeGreaterThan(3);
  });

  it("returns false when the tables are missing", async () => {
    const execute = vi.fn(async () => ({ rows: [] }));
    const db = { execute, transaction: async () => {} };
    const result = await applyMembershipAuthorityTtlConstraints(db as never);
    expect(result).toBe(false);
  });
});
