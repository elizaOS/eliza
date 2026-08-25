import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildHandoffDocument,
  extractCarryItems,
  generateAndWriteHandoff,
} from "./compaction-handoff.ts";
import type {
  CompactorMessage,
  CompactorTranscript,
} from "./conversation-compactor.types.ts";

const FIXED_NOW = new Date("2026-07-20T12:00:00Z");

/** Build a synthetic session with N seeded decisions + M seeded todos and
 * `padTurns` of filler conversation, deterministically. */
function syntheticSession(opts: {
  decisions?: string[];
  todos?: string[];
  openThreads?: string[];
  padTurns?: number;
  padText?: string;
}): CompactorTranscript {
  const messages: CompactorMessage[] = [];
  const push = (role: CompactorMessage["role"], content: string) =>
    messages.push({ role, content, timestamp: FIXED_NOW.getTime() });

  push("system", "You are Sol. Session start.");
  for (const d of opts.decisions ?? []) push("assistant", `DECISION: ${d}`);
  for (const t of opts.todos ?? []) push("user", `TODO: ${t}`);
  for (const o of opts.openThreads ?? [])
    push("assistant", `OPEN THREAD: ${o}`);

  const padText = opts.padText ?? "just some ordinary conversational filler";
  for (let i = 0; i < (opts.padTurns ?? 0); i++) {
    push(i % 2 === 0 ? "user" : "assistant", `turn ${i}: ${padText}`);
  }
  return { messages, metadata: { scenarioId: "m4-synthetic" } };
}

describe("compaction-handoff: extraction", () => {
  it("preserves ALL seeded decisions and todos from a 200-turn session", () => {
    const decisions = Array.from(
      { length: 7 },
      (_, i) => `locked decision ${i}`,
    );
    const todos = Array.from({ length: 9 }, (_, i) => `pending todo ${i}`);
    const openThreads = Array.from({ length: 4 }, (_, i) => `open thread ${i}`);
    // ~200 turns total once seeds + padding are combined
    const session = syntheticSession({
      decisions,
      todos,
      openThreads,
      padTurns: 200 - decisions.length - todos.length - openThreads.length - 1,
    });
    expect(session.messages.length).toBeGreaterThanOrEqual(200);

    const doc = buildHandoffDocument(session, { now: () => FIXED_NOW });

    expect(doc.decisions).toHaveLength(decisions.length);
    expect(doc.todos).toHaveLength(todos.length);
    expect(doc.openThreads).toHaveLength(openThreads.length);
    for (const d of decisions) expect(doc.markdown).toContain(d);
    for (const t of todos) expect(doc.markdown).toContain(t);
    for (const o of openThreads) expect(doc.markdown).toContain(o);
  });

  it("attaches provenance (turn + role) to each carried item", () => {
    const doc = buildHandoffDocument(
      syntheticSession({ decisions: ["ship M4"], todos: ["write tests"] }),
      { now: () => FIXED_NOW },
    );
    expect(doc.decisions[0].provenance.turn).toBe(2); // after system(1)
    expect(doc.decisions[0].provenance.role).toBe("assistant");
    expect(doc.markdown).toMatch(
      /ship M4 <!-- [0-9a-f]{16} turn=2 by=assistant/,
    );
  });

  it("recognizes bracket + checkbox marker variants", () => {
    const session: CompactorTranscript = {
      messages: [
        { role: "assistant", content: "[decision] use atomic rename" },
        { role: "user", content: "- [ ] add fixtures" },
        { role: "assistant", content: "[open-thread] revisit token cap" },
      ],
    };
    const { decisions, todos, openThreads } = extractCarryItems(session);
    expect(decisions.map((d) => d.text)).toContain("use atomic rename");
    expect(todos.map((t) => t.text)).toContain("add fixtures");
    expect(openThreads.map((o) => o.text)).toContain("revisit token cap");
  });

  it("de-duplicates repeated decisions, keeping first provenance", () => {
    const session: CompactorTranscript = {
      messages: [
        { role: "assistant", content: "DECISION: use develop as base" },
        { role: "user", content: "ok" },
        { role: "assistant", content: "decision: Use Develop As Base." },
      ],
    };
    const { decisions } = extractCarryItems(session);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].provenance.turn).toBe(1);
  });
});

describe("compaction-handoff: bounded size", () => {
  it("stays under the byte cap even with heavy padding, trimming only the tail", () => {
    const decisions = ["keep me A", "keep me B"];
    const todos = ["keep todo A", "keep todo B"];
    const session = syntheticSession({
      decisions,
      todos,
      padTurns: 400,
      padText: "x".repeat(300), // large filler to force trimming
    });
    const cap = 4 * 1024;
    const doc = buildHandoffDocument(session, {
      maxBytes: cap,
      now: () => FIXED_NOW,
    });

    expect(doc.bytes).toBeLessThanOrEqual(cap);
    expect(doc.tailTrimmed).toBe(true);
    // Preserved carry-forward survives the trim
    for (const d of decisions) expect(doc.markdown).toContain(d);
    for (const t of todos) expect(doc.markdown).toContain(t);
  });

  it("never drops load-bearing items even if that means exceeding the cap", () => {
    const decisions = Array.from(
      { length: 40 },
      (_, i) => `critical decision number ${i}`,
    );
    const doc = buildHandoffDocument(syntheticSession({ decisions }), {
      maxBytes: 256, // absurdly small: preserved set alone exceeds it
      now: () => FIXED_NOW,
    });
    for (const d of decisions) expect(doc.markdown).toContain(d);
    expect(doc.recentContext).toHaveLength(0); // tail fully trimmed first
  });
});

describe("compaction-handoff: atomic write + rotation", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "m4-handoff-"));
    delete process.env.CANONICAL_MEMORY_WRITE_ROOT;
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    delete process.env.CANONICAL_MEMORY_WRITE_ROOT;
    vi.restoreAllMocks();
  });

  const cfg = () => ({ writeRoot: root, now: () => FIXED_NOW });

  it("denies writes when no approved root is configured (file firewall)", async () => {
    const res = await generateAndWriteHandoff(
      syntheticSession({ decisions: ["x"] }),
      {
        now: () => FIXED_NOW,
      },
    );
    expect(res.ok).toBe(false);
    expect(res.denialReason).toBe("write-root-unset");
  });

  it("writes HANDOFF.md atomically leaving no temp sidecar", async () => {
    const res = await generateAndWriteHandoff(
      syntheticSession({ decisions: ["ship it"], todos: ["tests"] }),
      cfg(),
    );
    expect(res.ok).toBe(true);
    const files = await readdir(root);
    expect(files).toContain("HANDOFF.md");
    expect(files.filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
    const content = await readFile(path.join(root, "HANDOFF.md"), "utf8");
    expect(content).toContain("ship it");
    expect(content).toContain("tests");
  });

  it("rotation is atomic: a kill between temp-write and rename leaves the OLD complete file", async () => {
    // First handoff succeeds and is complete on disk.
    const first = await generateAndWriteHandoff(
      syntheticSession({ decisions: ["ORIGINAL decision"] }),
      cfg(),
    );
    expect(first.ok).toBe(true);
    const before = await readFile(path.join(root, "HANDOFF.md"), "utf8");
    expect(before).toContain("ORIGINAL decision");

    // Simulate kill -9 between temp-write and rename: rename throws.
    const fsPromises = await import("node:fs/promises");
    const spy = vi
      .spyOn(fsPromises.default, "rename")
      .mockRejectedValueOnce(new Error("simulated kill -9 before rename"));

    await expect(
      generateAndWriteHandoff(
        syntheticSession({ decisions: ["NEW decision"] }),
        cfg(),
      ),
    ).rejects.toThrow(/kill -9/);
    spy.mockRestore();

    // Old file is intact and complete; no torn/partial content, no leftover temp.
    const after = await readFile(path.join(root, "HANDOFF.md"), "utf8");
    expect(after).toBe(before);
    expect(after).toContain("ORIGINAL decision");
    expect(after).not.toContain("NEW decision");
    const files = await readdir(root);
    expect(files.filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
  });

  it("after a successful rotation the NEW complete file is present", async () => {
    await generateAndWriteHandoff(
      syntheticSession({ decisions: ["v1"] }),
      cfg(),
    );
    await generateAndWriteHandoff(
      syntheticSession({ decisions: ["v2"] }),
      cfg(),
    );
    const content = await readFile(path.join(root, "HANDOFF.md"), "utf8");
    expect(content).toContain("v2");
    expect(content).not.toContain("v1");
  });
});

describe("compaction-handoff: idempotent-ish repeated compaction", () => {
  const cfg = { now: () => FIXED_NOW };

  it("regenerating from the same session yields byte-identical output", () => {
    const session = syntheticSession({
      decisions: ["a", "b"],
      todos: ["c"],
      padTurns: 30,
    });
    const a = buildHandoffDocument(session, cfg);
    const b = buildHandoffDocument(session, cfg);
    expect(a.markdown).toBe(b.markdown);
  });

  it("re-compacting an already-compacted handoff does not grow unbounded", () => {
    const session = syntheticSession({
      decisions: ["persist decision"],
      todos: ["persist todo"],
      padTurns: 50,
    });
    const first = buildHandoffDocument(session, cfg);

    // Feed the prior handoff back in as a "prior context" turn (as a compaction
    // loop would) and re-run. Seeded items must not duplicate; size must not
    // balloon turn over turn.
    const withPrior: CompactorTranscript = {
      messages: [
        ...session.messages,
        { role: "system", content: `PRIOR HANDOFF:\n${first.markdown}` },
      ],
    };
    const second = buildHandoffDocument(withPrior, cfg);

    expect(second.decisions).toHaveLength(first.decisions.length);
    expect(second.todos).toHaveLength(first.todos.length);
    // The bounded doc never grows past the cap regardless of re-feeding.
    expect(second.bytes).toBeLessThanOrEqual(
      (cfg as { maxBytes?: number }).maxBytes ?? 16 * 1024,
    );
  });
});
