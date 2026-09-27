import { describe, expect, it } from "vitest";
import { checkReadOnly } from "../security/sql-readonly-guard.ts";
import { scanSqlForReadOnly } from "./sql-sanitizers.ts";

const SPLIT_IDENTIFIER_REASON =
  "Block comments between identifier characters are not allowed in read-only mode.";

describe("read-only SQL block comments", () => {
  it.each([
    "DELETE/**/FROM memories",
    "DROP/**/TABLE memories",
    "SELECT/**/pg_sleep(10)",
    "SELECT pg_/**/sleep(10)",
    "DE/*x*/LETE FROM t",
  ])("rejects a block comment between identifier characters in %s", (sql) => {
    expect(scanSqlForReadOnly(sql)).toEqual({
      ok: false,
      reason: SPLIT_IDENTIFIER_REASON,
    });
    expect(checkReadOnly(sql)).toEqual({
      ok: false,
      reason: SPLIT_IDENTIFIER_REASON,
    });
  });

  it("keeps a block comment as a token separator for policy checks", () => {
    expect(checkReadOnly("DELETE /**/FROM memories")).toEqual({
      ok: false,
      reason:
        '"DELETE" is a mutation keyword. Set allowWrites:true to execute mutations.',
    });
    expect(checkReadOnly("SELECT (/**/pg_sleep(10))")).toEqual({
      ok: false,
      reason:
        '"PG_SLEEP" is a dangerous function. Set allowWrites:true to execute.',
    });
  });

  it("still allows comments in read-only queries", () => {
    expect(checkReadOnly("SELECT /* a /* b */ c */ 1")).toEqual({ ok: true });
    expect(checkReadOnly("/* leading */SELECT 1")).toEqual({ ok: true });
  });
});
