/**
 * Hardened unit coverage for the linear SQL sanitizers used by the read-only
 * guard. Pins the documented invariants: unterminated constructs are preserved
 * (so invalid SQL never hides mutation text), and removal is linear.
 */
import { describe, expect, it } from "vitest";
import {
  stripSqlBlockComments,
  stripSqlDollarQuotedLiterals,
} from "./shared/sql-sanitizers.ts";

describe("stripSqlBlockComments", () => {
  it("removes a simple comment", () => {
    expect(stripSqlBlockComments("SELECT /* c */ 1")).toBe("SELECT  1");
  });

  it("removes multiple comments", () => {
    expect(stripSqlBlockComments("/* a */ SELECT /* b */ 1 /* c */")).toBe(
      " SELECT  1 ",
    );
  });

  it("preserves text after an unterminated comment (fail-safe)", () => {
    // Unterminated /* must not swallow the rest — invalid SQL keeps its
    // mutation text visible to the guard.
    expect(stripSqlBlockComments("/* never closed\nDELETE FROM t")).toBe(
      "/* never closed\nDELETE FROM t",
    );
  });

  it("preserves the inner opener of a PG-nested comment (non-nested strip)", () => {
    // "/* a /* b */ c */" — non-nested strip closes at the first */, leaving
    // " c */" which is still comment text in PG (depth not yet zero).
    expect(stripSqlBlockComments("/* a /* b */ c */")).toBe(" c */");
  });

  it("handles empty and comment-only input", () => {
    expect(stripSqlBlockComments("")).toBe("");
    expect(stripSqlBlockComments("/* only */")).toBe("");
  });
});

describe("stripSqlDollarQuotedLiterals", () => {
  it("removes a simple $$ literal", () => {
    expect(stripSqlDollarQuotedLiterals("SELECT $$DELETE$$")).toBe("SELECT  ");
  });

  it("removes a tagged literal", () => {
    expect(stripSqlDollarQuotedLiterals("SELECT $tag$DELETE FROM x$tag$")).toBe(
      "SELECT  ",
    );
  });

  it("preserves text after an unterminated dollar literal (fail-safe)", () => {
    expect(stripSqlDollarQuotedLiterals("SELECT $tag$DELETE")).toBe(
      "SELECT $tag$DELETE",
    );
  });

  it("preserves a mismatched-tag literal (open tag never closed)", () => {
    // $a$ opens, but only $b$ appears — $a$ is never closed, so everything is
    // preserved (invalid SQL must not hide mutation text).
    expect(stripSqlDollarQuotedLiterals("SELECT $a$1$b$ SELECT $c$2$c$")).toBe(
      "SELECT $a$1$b$ SELECT $c$2$c$",
    );
  });

  it("keeps lone dollar signs (not a quote opener)", () => {
    expect(stripSqlDollarQuotedLiterals("SELECT $5")).toBe("SELECT $5");
  });

  it("handles tags with digits/underscores", () => {
    expect(
      stripSqlDollarQuotedLiterals("SELECT $my_tag_1$DELETE$my_tag_1$"),
    ).toBe("SELECT  ");
  });
});
