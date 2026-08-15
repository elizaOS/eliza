/**
 * LOGS action=search must disclose every narrowing it applied and return the
 * NEWEST entries. Three narrowings stack invisibly: the source/level/tag/since
 * filters, the server's 200-entry tail of a larger ring buffer, and the
 * action's own `limit`. "Any errors from discord in the last hour?" answered a
 * bare "No log entries match." (read as "no errors happened"), and "show me
 * the last 20 errors" returned the twenty OLDEST entries of the recent window
 * because the preview sliced from the head. Deterministic: `fetch` is stubbed,
 * no server runs.
 */
import type { ActionResult, IAgentRuntime, Memory } from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";

import { logsAction } from "./logs.ts";

interface StubEntry {
  timestamp: number;
  level: string;
  message: string;
  source: string;
  tags: string[];
}

const runtime = { agentId: "agent-1" } as unknown as IAgentRuntime;
let restoreFetch: (() => void) | undefined;

function stubLogs(entries: StubEntry[]): void {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({ entries, sources: ["discord"], tags: [] }),
    }) as Response) as unknown as typeof fetch;
  restoreFetch = () => {
    globalThis.fetch = original;
  };
}

/** Oldest first, exactly as the server's ring buffer hands them back. */
function makeEntries(count: number): StubEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    timestamp: 1_700_000_000_000 + index * 1000,
    level: "error",
    message: `entry-${index}`,
    source: "discord",
    tags: [],
  }));
}

async function search(
  parameters: Record<string, unknown>,
): Promise<ActionResult> {
  const result = await logsAction.handler(
    runtime,
    { content: { text: "" } } as Memory,
    undefined,
    { parameters: { action: "search", ...parameters } } as never,
    undefined,
  );
  if (!result) throw new Error("handler returned no result");
  return result;
}

afterEach(() => {
  restoreFetch?.();
  restoreFetch = undefined;
});

describe("LOGS action=search window disclosure", () => {
  it("names the filters and the server cap when nothing matched", async () => {
    stubLogs([]);

    const result = await search({ source: "discord", level: "error" });
    const text = String(result.text ?? "");

    expect(text).toContain("No log entries match.");
    expect(text).toContain("source=discord");
    expect(text).toContain("level=error");
    expect(text).toContain("most recent buffered log entries");
    expect(text).toContain("not proof nothing was logged");
  });

  it("reports matched-vs-shown counts and the filters on a populated result", async () => {
    stubLogs(makeEntries(60));

    const result = await search({ level: "error", limit: 20 });
    const text = String(result.text ?? "");

    expect(text).toContain("Showing 20 of 60 matching entries");
    expect(text).toContain("level=error");
    expect(text).toContain("most recent buffered log entries");
    expect(result.values).toMatchObject({ count: 60, shown: 20 });
  });

  it('returns the NEWEST entries so "last N" means last N', async () => {
    stubLogs(makeEntries(60));

    const result = await search({ limit: 20 });
    const text = String(result.text ?? "");

    // Newest 20 of 0..59 is 40..59. The head slice returned entry-0..entry-19
    // and the model presented those stale lines as the latest errors.
    expect(text).toContain("entry-59");
    expect(text).toContain("entry-40");
    expect(text).not.toContain("entry-39");
    expect(text).not.toContain("entry-0 ");
    const entries = (result.data as { entries: StubEntry[] }).entries;
    expect(entries).toHaveLength(20);
    expect(entries[entries.length - 1].message).toBe("entry-59");
  });
});
