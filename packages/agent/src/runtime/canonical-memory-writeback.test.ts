import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  authorizeWrite,
  readCanonicalFacts,
  recordCanonicalFact,
} from "./canonical-memory-writeback.ts";

const FIXED_NOW = new Date("2026-07-20T12:00:00Z");
const DAILY_REL = "memory/2026-07-20.md";

describe("canonical-memory-writeback", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "canon-writeback-"));
    delete process.env.CANONICAL_MEMORY_WRITE_ROOT;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    delete process.env.CANONICAL_MEMORY_WRITE_ROOT;
  });

  const cfg = () => ({ writeRoot: root, now: () => FIXED_NOW });

  const fact = (
    text: string,
    extra: Partial<Parameters<typeof recordCanonicalFact>[0]> = {},
  ) => ({
    text,
    provenance: { source: "test", userId: "user-1", conversationRef: "room-9" },
    ...extra,
  });

  it("denies every write when no root is configured (deny-by-default)", async () => {
    const res = await recordCanonicalFact(fact("hello"), {
      now: () => FIXED_NOW,
    });
    expect(res.ok).toBe(false);
    expect(res.denialReason).toBe("write-root-unset");
    expect(res.auditReason).toMatch(/no approved write root/);
  });

  it("denies path escape outside the approved root with an auditable reason", () => {
    const authz = authorizeWrite("../outside.md", cfg());
    expect(authz.ok).toBe(false);
    if (!authz.ok) {
      expect(authz.result.denialReason).toBe("write-root-escape");
      expect(authz.result.auditReason).toMatch(/outside approved root/);
    }
  });

  it("denies files not matching the allowed patterns", () => {
    const authz = authorizeWrite("memory/secrets.txt", cfg());
    expect(authz.ok).toBe(false);
    if (!authz.ok)
      expect(authz.result.denialReason).toBe("pattern-not-allowed");
  });

  it("appends a fact with full provenance to today's daily file", async () => {
    const res = await recordCanonicalFact(
      fact("Shadow started a new habit"),
      cfg(),
    );
    expect(res.ok).toBe(true);
    expect(res.outcome).toBe("appended");
    const content = await readFile(path.join(root, DAILY_REL), "utf8");
    expect(content).toContain("Shadow started a new habit");
    expect(content).toContain("provenance: test user=user-1 ref=room-9");
    expect(content).toContain("at=2026-07-20T12:00:00.000Z");
    expect(content).toContain(`<!-- fact:${res.factId}`);
  });

  it("is exactly-once per fact id: duplicate submission does not duplicate", async () => {
    const first = await recordCanonicalFact(
      fact("only once", { factId: "abc123" }),
      cfg(),
    );
    const second = await recordCanonicalFact(
      fact("only once", { factId: "abc123" }),
      cfg(),
    );
    expect(first.outcome).toBe("appended");
    expect(second.outcome).toBe("duplicate");
    const content = await readFile(path.join(root, DAILY_REL), "utf8");
    expect(content.match(/only once/g)).toHaveLength(1);
  });

  it("derives a stable fact id from text+user when caller supplies none", async () => {
    const a = await recordCanonicalFact(fact("same text"), cfg());
    const b = await recordCanonicalFact(fact("same text"), cfg());
    expect(a.factId).toBe(b.factId);
    expect(b.outcome).toBe("duplicate");
  });

  it("corrections supersede instead of duplicating, append-only", async () => {
    const orig = await recordCanonicalFact(
      fact("gym at 4pm", { factId: "f-orig" }),
      cfg(),
    );
    expect(orig.outcome).toBe("appended");
    const corr = await recordCanonicalFact(
      fact("gym at 5pm actually", {
        factId: "f-corr",
        supersedesFactId: "f-orig",
      }),
      cfg(),
    );
    expect(corr.outcome).toBe("appended");
    const content = await readFile(path.join(root, DAILY_REL), "utf8");
    // both entries remain (append-only), correction is linked
    expect(content).toContain("gym at 4pm");
    expect(content).toContain("gym at 5pm actually");
    expect(content).toContain("supersedes:f-orig");
    expect(content).toContain("**CORRECTION:**");

    const facts = await readCanonicalFacts(FIXED_NOW, cfg());
    const origEntry = facts.find((f) => f.factId === "f-orig");
    expect(origEntry?.supersededBy).toBe("f-corr");
  });

  it("leaves no temp sidecar files after writes (atomic temp+rename)", async () => {
    await recordCanonicalFact(fact("a"), cfg());
    await recordCanonicalFact(fact("b"), cfg());
    const files = await readdir(path.join(root, "memory"));
    expect(files.filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
    expect(files).toContain("2026-07-20.md");
  });

  it("rejects empty or provenance-less facts", async () => {
    const empty = await recordCanonicalFact(fact("   "), cfg());
    expect(empty.denialReason).toBe("invalid-fact");
    const noProv = await recordCanonicalFact(
      { text: "x", provenance: { source: "", userId: "" } },
      cfg(),
    );
    expect(noProv.denialReason).toBe("invalid-fact");
  });

  it("honors CANONICAL_MEMORY_WRITE_ROOT env when config omits writeRoot", async () => {
    process.env.CANONICAL_MEMORY_WRITE_ROOT = root;
    const res = await recordCanonicalFact(fact("env root works"), {
      now: () => FIXED_NOW,
    });
    expect(res.ok).toBe(true);
    expect(res.outcome).toBe("appended");
  });
});
