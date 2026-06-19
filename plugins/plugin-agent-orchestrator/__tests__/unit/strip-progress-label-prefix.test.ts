import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  compactProgressText,
  plannerAlreadyAckedSpawn,
  resolveSubAgentProgressPolicy,
  stripProgressLabelPrefix,
} from "../../src/index.js";

function runtimeWithSettings(
  settings: Record<string, string | undefined>,
): IAgentRuntime {
  return {
    getSetting: (key: string) => settings[key],
  } as unknown as IAgentRuntime;
}

describe("stripProgressLabelPrefix", () => {
  it("strips a 💬 narration label prefix", () => {
    expect(stripProgressLabelPrefix("💬 [foo] Reading file...")).toBe(
      "💬 Reading file...",
    );
  });

  it("strips ⏳ heartbeat prefix", () => {
    expect(
      stripProgressLabelPrefix("⏳ [my-label] still iterating on styles.css"),
    ).toBe("⏳ still iterating on styles.css");
  });

  it("strips ⚠️ (variation-selector composite) — regression for character-class bug", () => {
    // Earlier revisions used `[💬⏳⚠️⏸️…]` which only matches the first
    // codepoint (U+26A0), leaving U+FE0F + the bracket behind. The regex
    // MUST use alternation so the full grapheme is consumed.
    expect(stripProgressLabelPrefix("⚠️ [foo] auth error")).toBe("⚠️ auth error");
  });

  it("strips ⏸️ (variation-selector composite)", () => {
    expect(stripProgressLabelPrefix("⏸️ [bar] blocked")).toBe("⏸️ blocked");
  });

  it("strips ✅ / ❌ / 🚀 prefixes", () => {
    expect(stripProgressLabelPrefix("✅ [a] done")).toBe("✅ done");
    expect(stripProgressLabelPrefix("❌ [b] failed")).toBe("❌ failed");
    expect(stripProgressLabelPrefix("🚀 [c] running")).toBe("🚀 running");
  });

  it("leaves text without a known prefix untouched", () => {
    expect(stripProgressLabelPrefix("plain message")).toBe("plain message");
    expect(stripProgressLabelPrefix("📦 [foo] not a progress emoji")).toBe(
      "📦 [foo] not a progress emoji",
    );
  });

  it("only strips ONE leading prefix even if the body contains another", () => {
    expect(stripProgressLabelPrefix("💬 [a] saw ⏳ [b] inside")).toBe(
      "💬 saw ⏳ [b] inside",
    );
  });

  it("does not strip when the bracket label is missing", () => {
    expect(stripProgressLabelPrefix("💬 no bracket here")).toBe(
      "💬 no bracket here",
    );
  });

  it("formats compact progress without emoji or duplicated labels", () => {
    expect(compactProgressText("🚀 [tweet-idea-app] running")).toBe("running");
    expect(compactProgressText("💬 [tweet-idea-app] Writing files")).toBe(
      "Writing files",
    );
  });

  it("defaults to compact delayed progress with no reactions", () => {
    expect(resolveSubAgentProgressPolicy(runtimeWithSettings({}))).toEqual({
      mode: "compact",
      reactions: false,
      delayMs: 15000,
    });
  });

  it("supports explicit threaded progress as an opt-in", () => {
    expect(
      resolveSubAgentProgressPolicy(
        runtimeWithSettings({
          ACPX_PROGRESS_MODE: "threaded",
          ACPX_PROGRESS_REACTIONS: "1",
          ACPX_PROGRESS_DELAY_MS: "0",
        }),
      ),
    ).toEqual({
      mode: "threaded",
      reactions: true,
      delayMs: 0,
    });
  });

  it("supports the ack progress mode (post spawn ack once, never edit)", () => {
    expect(
      resolveSubAgentProgressPolicy(
        runtimeWithSettings({ ACPX_PROGRESS_MODE: "ack" }),
      ).mode,
    ).toBe("ack");
  });

  it("forces delayMs=0 in ack mode even when a delay is configured — fail-on-old", () => {
    // The spawn ACK is one-shot: the post-delay debounce would DROP it when a
    // fast sub-agent finishes before the timer fires. ack mode must ignore any
    // configured delay so the ack is reliable.
    expect(
      resolveSubAgentProgressPolicy(
        runtimeWithSettings({
          ACPX_PROGRESS_MODE: "ack",
          ACPX_PROGRESS_DELAY_MS: "15000",
        }),
      ).delayMs,
    ).toBe(0);
  });

  it("reads the progress mode from process.env when getSetting lacks it — fail-on-old", () => {
    // runtime.getSetting() reads character settings only and never consults
    // process.env, so an env-only ACPX_PROGRESS_MODE was silently ignored and
    // the policy stayed "compact" (the root cause of the in-place message
    // editing the user reported). The env fallback must honor it.
    const prev = process.env.ACPX_PROGRESS_MODE;
    process.env.ACPX_PROGRESS_MODE = "ack";
    try {
      expect(resolveSubAgentProgressPolicy(runtimeWithSettings({})).mode).toBe(
        "ack",
      );
    } finally {
      if (prev === undefined) delete process.env.ACPX_PROGRESS_MODE;
      else process.env.ACPX_PROGRESS_MODE = prev;
    }
  });
});

describe("plannerAlreadyAckedSpawn", () => {
  const LOOKBACK = 8000;
  const createdAt = 1_000_000;

  it("SUPPRESSES when the planner replied exactly at createdAt", () => {
    // Planner "On it." sent in the same turn it spawned — the orchestrator
    // must stay silent so the user sees one ack, not two.
    expect(plannerAlreadyAckedSpawn(createdAt, createdAt, LOOKBACK)).toBe(true);
  });

  it("SUPPRESSES when the planner replied within the lookback before createdAt", () => {
    // REPLY action ran just before the TASKS spawn action in the same turn.
    expect(
      plannerAlreadyAckedSpawn(createdAt - 2000, createdAt, LOOKBACK),
    ).toBe(true);
    expect(
      plannerAlreadyAckedSpawn(createdAt - LOOKBACK, createdAt, LOOKBACK),
    ).toBe(true);
  });

  it("SUPPRESSES when the planner replied after createdAt (spawn action ran first)", () => {
    expect(
      plannerAlreadyAckedSpawn(createdAt + 1500, createdAt, LOOKBACK),
    ).toBe(true);
  });

  it("ALLOWS the orchestrator ack when the planner reply is older than the lookback", () => {
    // A previous task's completion summary from an earlier turn must NOT
    // suppress this fresh spawn's ack.
    expect(
      plannerAlreadyAckedSpawn(createdAt - LOOKBACK - 1, createdAt, LOOKBACK),
    ).toBe(false);
    expect(
      plannerAlreadyAckedSpawn(createdAt - 600_000, createdAt, LOOKBACK),
    ).toBe(false);
  });

  it("ALLOWS the orchestrator ack when the planner never replied to the room", () => {
    expect(plannerAlreadyAckedSpawn(undefined, createdAt, LOOKBACK)).toBe(
      false,
    );
  });

  it("ALLOWS the orchestrator ack when the session createdAt is unknown", () => {
    // Can't attribute a reply to the spawn turn without createdAt — default to
    // posting the ack rather than risk silently dropping it.
    expect(plannerAlreadyAckedSpawn(createdAt, undefined, LOOKBACK)).toBe(
      false,
    );
  });
});
