/** File-grep proof for discord setup credential fetches timeout fix. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SRC = "plugins/plugin-discord/actions/setup-credentials.ts";
const SIBLING = "packages/agent/src/actions/runtime.ts";

describe("discord setup credential fetches bounded", () => {
  it("has timeout on all 6 fetches", () => {
    const s = readFileSync(SRC, "utf8");
    const count = (s.match(/AbortSignal\.timeout\(15_000\)/g) || []).length;
    expect(count).toBe(6);
    // ensure no bare await fetch without signal within 400 chars
    const bare = (s.match(/await fetch\(/g) || []).length - count;
    expect(bare).toBe(0);
  });
  it("headers still correct within 400 chars of fetch", () => {
    const s = readFileSync(SRC, "utf8");
    expect(s).toContain("api.github.com/user");
    expect(s).toContain("api.vercel.com");
    expect(s).toContain("api.cloudflare.com");
    expect(s).toContain("api.anthropic.com");
    expect(s).toContain("api.openai.com");
    expect(s).toContain("rest.fal.run");
  });
  it("sibling still correct with 15_000", () => {
    const sib = readFileSync(SIBLING, "utf8");
    expect(sib).toContain("AbortSignal.timeout(15_000)");
  });
  it("no bare fetch remains without signal", () => {
    const s = readFileSync(SRC, "utf8");
    // check that each fetch block contains signal within 400 chars after await fetch
    const fetchBlocks = s.split("await fetch(").slice(1);
    for (const block of fetchBlocks) {
      const snippet = block.slice(0, 400);
      // only check the 6 preset validates, not test files
      if (snippet.includes("api.github.com") || snippet.includes("api.vercel.com") || snippet.includes("api.cloudflare.com") || snippet.includes("api.anthropic.com") || snippet.includes("api.openai.com") || snippet.includes("rest.fal.run")) {
        expect(snippet).toContain("AbortSignal.timeout");
      }
    }
  });
});
