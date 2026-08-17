import { describe, it, expect } from "vitest";
import fs from "node:fs";
describe("gateway webhook timeout",()=>{
  it("has AbortSignal.timeout 15_000 in wakeServer PATCH",()=>{
    const src=fs.readFileSync("packages/cloud/services/gateway-webhook/src/server-router.ts","utf8");
    expect(src).toContain("signal: AbortSignal.timeout(15_000)");
  });
  it("count 1 timeout in wakeServer",()=>{
    const src=fs.readFileSync("packages/cloud/services/gateway-webhook/src/server-router.ts","utf8");
    // the wakeServer PATCH should have timeout, plus existing forwardToServer already has controller.signal, but count timeout should be 1
    const timeouts=(src.match(/AbortSignal\.timeout\(15_000\)/g)||[]).length;
    expect(timeouts).toBe(1);
  });
  it("no bare await fetch(apiUrl without signal in wakeServer",()=>{
    const src=fs.readFileSync("packages/cloud/services/gateway-webhook/src/server-router.ts","utf8");
    // ensure the PATCH block now contains signal
    expect(src).toContain('method: "PATCH",\n      signal: AbortSignal.timeout(15_000),');
  });
  it("sibling correct still has disciplined timeout",()=>{
    const runtime=fs.readFileSync("packages/agent/src/actions/runtime.ts","utf8");
    expect(runtime).toContain("AbortSignal.timeout(15_000)");
    const forwarder=fs.readFileSync("packages/cloud/services/gateway-discord/src/server-router.ts","utf8");
    // forwardToServer uses controller.signal with FORWARD_TIMEOUT_MS 30_000
    expect(forwarder).toContain("controller.signal");
  });
});
