import { beforeEach, describe, expect, it, vi } from "vitest";
import * as sqlMod from "../../lifeops/sql.js";
import { hasActiveHarshNoBypassRule } from "./harsh-mode-check.js";

function makeRuntime(db: unknown, agentId = "agent-1") {
  return {
    agentId,
    adapter: { db },
  };
}

describe("hasActiveHarshNoBypassRule", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("fails closed to false when the runtime exposes no db adapter", async () => {
    const spy = vi.spyOn(sqlMod, "executeRawSql");
    const result = await hasActiveHarshNoBypassRule(makeRuntime(undefined));
    expect(result).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("fails closed to false when the db lacks an execute function", async () => {
    const spy = vi.spyOn(sqlMod, "executeRawSql");
    const result = await hasActiveHarshNoBypassRule(makeRuntime({}));
    expect(result).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("queries the block-rules table with the agent id quoted and the harsh gate type", async () => {
    const spy = vi.spyOn(sqlMod, "executeRawSql").mockResolvedValue([]);
    const db = { execute: vi.fn() };
    const result = await hasActiveHarshNoBypassRule(
      makeRuntime(db, "agent-42"),
    );
    expect(result).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
    const [, sql] = spy.mock.calls[0];
    expect(sql).toContain("app_lifeops.life_block_rules");
    expect(sql).toContain("agent_id = 'agent-42'");
    expect(sql).toContain("active = TRUE");
    expect(sql).toContain("gate_type = 'harsh_no_bypass'");
    expect(sql).toContain("LIMIT 1");
  });

  it("quotes single quotes inside the agent id to defeat SQL injection", async () => {
    const spy = vi.spyOn(sqlMod, "executeRawSql").mockResolvedValue([]);
    const db = { execute: vi.fn() };
    await hasActiveHarshNoBypassRule(makeRuntime(db, "agent-1' OR '1'='1"));
    const [, sql] = spy.mock.calls[0];
    expect(sql).toContain("agent_id = 'agent-1'' OR ''1''=''1'");
    expect(sql).not.toContain("OR '1'='1'");
  });

  it("returns true when the query returns rows", async () => {
    vi.spyOn(sqlMod, "executeRawSql").mockResolvedValue([{ ok: 1 }]);
    const result = await hasActiveHarshNoBypassRule(
      makeRuntime({ execute: vi.fn() }),
    );
    expect(result).toBe(true);
  });

  it("returns false when the query returns no rows", async () => {
    vi.spyOn(sqlMod, "executeRawSql").mockResolvedValue([]);
    const result = await hasActiveHarshNoBypassRule(
      makeRuntime({ execute: vi.fn() }),
    );
    expect(result).toBe(false);
  });

  it("propagates db failures instead of silently opening the unblock path", async () => {
    vi.spyOn(sqlMod, "executeRawSql").mockRejectedValue(
      new Error("connection refused"),
    );
    await expect(
      hasActiveHarshNoBypassRule(makeRuntime({ execute: vi.fn() })),
    ).rejects.toThrow("connection refused");
  });
});
