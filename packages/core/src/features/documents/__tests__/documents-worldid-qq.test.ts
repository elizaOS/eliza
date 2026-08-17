/**
 * Proves documents worldId/roomId ?? tenant scope (rank 9 systematic).
 * Covers docs-loader, document-processor, service — || agentId → ?? agentId preserves "" vs undefined.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const loaderPath = new URL("../docs-loader.ts", import.meta.url).pathname;
const processorPath = new URL("../document-processor.ts", import.meta.url).pathname;
const servicePath = new URL("../service.ts", import.meta.url).pathname;

describe("documents worldId/roomId — file uses ?? not || for agentId fallback", () => {
  test("docs-loader uses ?? not || for worldId/roomId/entityId", () => {
    const src = readFileSync(loaderPath, "utf8");
    expect(src).toContain("worldId: worldId ?? agentId,");
    expect(src).toContain("roomId: roomId ?? agentId,");
    expect(src).toContain("entityId: entityId ?? agentId,");
    expect(src).not.toContain("worldId: worldId || agentId");
    expect(src).not.toContain("roomId: roomId || agentId");
  });

  test("document-processor uses ?? not || for fragment scope", () => {
    const src = readFileSync(processorPath, "utf8");
    // processFragmentsSynchronously block and processAndSaveFragments block both use ??
    expect((src.match(/worldId: worldId \?\? agentId/g) || []).length).toBeGreaterThanOrEqual(2);
    expect((src.match(/roomId: roomId \?\? agentId/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(src).not.toContain("worldId: worldId || agentId");
    expect(src).not.toContain("roomId: roomId || agentId");
  });

  test("service uses ?? not || for memory scope", () => {
    const src = readFileSync(servicePath, "utf8");
    expect(src).toContain("roomId: roomId ?? agentId,");
    expect(src).toContain("worldId: worldId ?? agentId,");
    expect(src).not.toContain("roomId: roomId || agentId,");
    // single || check covers all 5 sites (no || agentId remains in this file for this scope)
    expect(src).not.toContain("worldId: worldId || agentId,");
  });

  test("direct ?? vs || proof preserves empty-string sentinel", () => {
    const empty: string | undefined = "";
    const undef: string | undefined = undefined;
    const agent = "agent-123";
    // || collapses "" to fallback (tenant leak: empty worldId becomes agentId world)
    expect((empty as any) || agent).toBe(agent);
    expect((empty as any) ?? agent).toBe("");
    expect(undef ?? agent).toBe(agent);
    expect((undef as any) || agent).toBe(agent);
    // sibling already uses ?? at processor:144 — proves intent
  });
});
