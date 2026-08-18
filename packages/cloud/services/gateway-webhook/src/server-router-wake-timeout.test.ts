/**
 * Proves wakeServer K8s PATCH is bounded by AbortSignal.timeout(15_000).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const file = readFileSync(
  resolve("packages/cloud/services/gateway-webhook/src/server-router.ts"),
  "utf8",
);
const siblingPath = resolve(
  "plugins/plugin-health/src/health-bridge/health-oauth.ts",
);
let sibling = "";
try {
  sibling = readFileSync(siblingPath, "utf8");
} catch {}

describe("gateway-webhook wakeServer timeout", () => {
  it("reserve present: wakeServer PATCH bounded by 15s", () => {
    expect(file).toContain("signal: AbortSignal.timeout(15_000)");
    expect(file).toContain("kubernetes.default.svc");
    const wakeIdx = file.indexOf("async function wakeServer");
    const sigIdx = file.indexOf("signal: AbortSignal.timeout(15_000)");
    expect(wakeIdx).toBeGreaterThan(-1);
    expect(sigIdx).toBeGreaterThan(wakeIdx);
  });

  it("no bare fetch without signal in wakeServer", () => {
    const start = file.indexOf("async function wakeServer");
    const snippet = file.slice(start, start + 1200);
    const fetchBlocks = [
      ...snippet.matchAll(
        /await fetch\(apiUrl, \{([\s\S]*?)\} as RequestInit\)/g,
      ),
    ];
    expect(fetchBlocks.length).toBe(1);
    for (const m of fetchBlocks) {
      expect(m[1]).toContain("signal: AbortSignal.timeout(15_000)");
    }
    expect(snippet).not.toMatch(
      /await fetch\(apiUrl, \{[^}]*method: "PATCH"[^}]*tls: \{[^}]*\}[^}]*\} as RequestInit\)/s,
    );
  });

  it("count: exactly one bounded K8s PATCH", () => {
    const count = (file.match(/signal: AbortSignal\.timeout\(15_000\)/g) || [])
      .length;
    expect(count).toBeGreaterThanOrEqual(1);
    const wakeCount = (
      file
        .slice(
          file.indexOf("async function wakeServer"),
          file.indexOf("async function wakeServer") + 1500,
        )
        .match(/signal: AbortSignal\.timeout\(15_000\)/g) || []
    ).length;
    expect(wakeCount).toBe(1);
  });

  it("payload weak vs fixed + sibling correct", () => {
    const weak =
      'await fetch(apiUrl, { method: "PATCH", headers: { Authorization:';
    const fixed = "signal: AbortSignal.timeout(15_000)";
    expect(file).not.toContain(
      weak.replace("signal: AbortSignal.timeout(15_000),", ""),
    );
    expect(file).toContain(fixed);
    expect(sibling).toContain("signal: AbortSignal.timeout(15_000)");
    expect(sibling).toMatch(/AbortSignal\.timeout\(15_000\)/);
  });
});
