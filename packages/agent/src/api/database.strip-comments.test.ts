/**
 * Unit coverage for `stripSqlBlockComments` (database.ts), the linear-pass
 * block-comment stripper the read-only SQL guard runs before scanning for
 * mutation keywords. It replaced a `/\/\*[\s\S]*?\*\//g` regex that was O(n²)
 * on attacker-supplied SQL (many comment openers, no closer). These tests pin
 * the exact strip semantics — including the token-concatenation the guard
 * relies on — and prove the pathological input now completes in linear time.
 * Deterministic, no server or DB.
 */
import { describe, expect, it } from "vitest";
import {
  stripSqlBlockComments,
  stripSqlDollarQuotedLiterals,
} from "../shared/sql-sanitizers.ts";

describe("stripSqlBlockComments", () => {
  it("leaves comment-free SQL untouched", () => {
    expect(stripSqlBlockComments("SELECT 1 FROM t")).toBe("SELECT 1 FROM t");
  });

  it("removes a block comment with empty replacement", () => {
    expect(stripSqlBlockComments("SELECT /* c */ 1")).toBe("SELECT  1");
  });

  it("concatenates tokens split by a comment (the guard's bypass defense)", () => {
    // DE/* */LETE must collapse to DELETE so the mutation-keyword scan sees it.
    expect(stripSqlBlockComments("DE/* */LETE")).toBe("DELETE");
  });

  it("removes multiple comments", () => {
    expect(stripSqlBlockComments("a/*x*/b/*y*/c")).toBe("abc");
  });

  it("collapses an empty comment", () => {
    expect(stripSqlBlockComments("/**/")).toBe("");
  });

  it("matches the shortest comment (non-nested), leaving the tail", () => {
    expect(stripSqlBlockComments("/* a /* b */ c */")).toBe(" c */");
  });

  it("leaves an unterminated opener intact", () => {
    expect(stripSqlBlockComments("SELECT /* unterminated")).toBe(
      "SELECT /* unterminated",
    );
  });

  it("is linear on the ReDoS input (many openers, no closer)", () => {
    // The old regex was O(n²) here and took seconds; this must finish in ms.
    const evil = `/*${"a/*".repeat(200_000)}`;
    const start = performance.now();
    const out = stripSqlBlockComments(evil);
    const elapsed = performance.now() - start;
    // No closing "*/" anywhere, so nothing is stripped.
    expect(out).toBe(evil);
    expect(elapsed).toBeLessThan(1000);
  });
});

describe("stripSqlDollarQuotedLiterals", () => {
  it("strips untagged and tagged dollar-quoted SQL literals", () => {
    expect(
      stripSqlDollarQuotedLiterals("SELECT $$DROP$$, $tag$ALTER$tag$"),
    ).toBe("SELECT  ,  ");
  });

  it("leaves unterminated literals intact so the guard still sees following SQL", () => {
    expect(
      stripSqlDollarQuotedLiterals("SELECT $tag$ unterminated DELETE"),
    ).toBe("SELECT $tag$ unterminated DELETE");
  });

  it("is linear on many unterminated dollar-quote openers", () => {
    const evil = Array.from({ length: 50_000 }, (_, i) => `$tag${i}$x`).join(
      "",
    );
    const start = performance.now();
    const out = stripSqlDollarQuotedLiterals(evil);
    const elapsed = performance.now() - start;
    expect(out).toBe(evil);
    expect(elapsed).toBeLessThan(1000);
  });
});
