import { describe, expect, it } from "vitest";
import type { SelfControlBlockMetadata } from "./engine.ts";
import {
  buildSelfControlManagedHostsBlock,
  formatWebsiteList,
} from "./engine.ts";

/**
 * Tests for the website-blocker ENFORCEMENT-content builder (#8801 / #9943).
 * `buildSelfControlManagedHostsBlock` produces the `/etc/hosts` block that
 * actually sinkholes blocked sites — the security-relevant payload — and it had
 * no assertions. The eliza markers are a contract (the unblock path scans for
 * them), so they are asserted literally.
 */
const START = "# >>> eliza-selfcontrol >>>";
const END = "# <<< eliza-selfcontrol <<<";
const META_PREFIX = "# eliza-selfcontrol ";

function meta(
  overrides: Partial<SelfControlBlockMetadata> = {},
): SelfControlBlockMetadata {
  return {
    version: 1,
    startedAt: "2026-01-01T00:00:00.000Z",
    endsAt: null,
    websites: ["example.com"],
    managedBy: "agent",
    metadata: null,
    ...overrides,
  };
}

describe("buildSelfControlManagedHostsBlock", () => {
  it("sinkholes each website to 0.0.0.0 + ::1 between the eliza markers", () => {
    const block = buildSelfControlManagedHostsBlock(
      meta({ websites: ["a.example", "b.example"] }),
    );
    const lines = block.split("\n");
    expect(lines[0]).toBe(START);
    expect(lines).toContain(END);
    for (const host of ["a.example", "b.example"]) {
      expect(block).toContain(`0.0.0.0 ${host}`);
      expect(block).toContain(`::1 ${host}`);
    }
  });

  it("prefers blockedWebsites over websites when present", () => {
    const block = buildSelfControlManagedHostsBlock(
      meta({
        websites: ["fallback.example"],
        blockedWebsites: ["actual.example"],
      }),
    );
    // the sinkhole ENTRY uses blockedWebsites; `fallback.example` may still
    // appear inside the embedded metadata JSON, so assert on the host line.
    expect(block).toContain("0.0.0.0 actual.example");
    expect(block).not.toContain("0.0.0.0 fallback.example");
  });

  it("falls back to websites when blockedWebsites is empty", () => {
    const block = buildSelfControlManagedHostsBlock(
      meta({ websites: ["w.example"], blockedWebsites: [] }),
    );
    expect(block).toContain("0.0.0.0 w.example");
  });

  it("honors a custom line ending", () => {
    const block = buildSelfControlManagedHostsBlock(meta(), "\r\n");
    expect(block.split("\r\n")[0]).toBe(START);
    expect(block).toContain("\r\n");
    expect(block).not.toMatch(/[^\r]\n/);
  });

  it("embeds the round-trippable metadata JSON on the prefix line", () => {
    const m = meta({ endsAt: "2026-01-02T00:00:00.000Z" });
    const metaLine = buildSelfControlManagedHostsBlock(m)
      .split("\n")
      .find((l) => l.startsWith(META_PREFIX));
    expect(metaLine).toBeDefined();
    if (!metaLine) {
      throw new Error("missing metadata line");
    }
    expect(JSON.parse(metaLine.slice(META_PREFIX.length))).toEqual(m);
  });
});

describe("formatWebsiteList", () => {
  it("joins up to three with commas", () => {
    expect(formatWebsiteList(["only.one"])).toBe("only.one");
    expect(formatWebsiteList(["a", "b", "c"])).toBe("a, b, c");
  });

  it("summarizes more than three with an 'and N more' tail", () => {
    expect(formatWebsiteList(["a", "b", "c", "d", "e"])).toBe(
      "a, b, c, and 2 more",
    );
  });
});
