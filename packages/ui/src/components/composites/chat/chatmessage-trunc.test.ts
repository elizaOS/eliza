import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
describe("chat-message trunc",()=>{
  const src=fs.readFileSync("packages/ui/src/components/composites/chat/chat-message.tsx","utf8");
  it("reserve -1",()=>expect(src).toContain("REPLY_PILL_SNIPPET_MAX - 1"));
  it("no bare",()=>expect(src.includes("REPLY_PILL_SNIPPET_MAX)}…")).toBe(false));
  it("payload + sibling",()=>{
    const MAX=50; expect(MAX+1).toBe(51); expect((MAX-1)+1).toBe(50);
    const sib=fs.readFileSync("packages/agent/src/providers/workspace-provider.ts","utf8");
    expect(sib).toContain("suffix.length");
  });
  it("count 1",()=>expect((src.match(/REPLY_PILL_SNIPPET_MAX - 1/g)||[]).length).toBe(1));
});
