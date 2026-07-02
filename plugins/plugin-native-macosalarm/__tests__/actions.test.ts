import type { Memory, State } from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAlarmAction,
  hasAlarmContext,
  resolveSubaction,
} from "../src/actions";

/**
 * #10471 — the ALARM action must route by the planner's structured context
 * decision + structured params, NOT by English (or multilingual) keyword
 * matching on raw message text. These pin that the removed `ALARM_TERMS` keyword
 * bank and text-regex subaction inference stay gone.
 */

function msg(text = "", content: Record<string, unknown> = {}): Memory {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    entityId: "00000000-0000-0000-0000-000000000002",
    agentId: "00000000-0000-0000-0000-000000000003",
    roomId: "00000000-0000-0000-0000-000000000004",
    content: { text, source: "test", ...content },
    createdAt: 0,
  } as unknown as Memory;
}

function stateWithRouting(routing: unknown): State {
  return {
    values: { __contextRouting: routing },
    data: {},
    text: "",
  } as unknown as State;
}

describe("hasAlarmContext (canonical routing, no keyword bank)", () => {
  it("matches an alarm context from the canonical __contextRouting primaryContext", () => {
    expect(
      hasAlarmContext(msg(), stateWithRouting({ primaryContext: "tasks" })),
    ).toBe(true);
  });

  it("matches from a __contextRouting secondaryContext", () => {
    expect(
      hasAlarmContext(
        msg(),
        stateWithRouting({
          primaryContext: "chat",
          secondaryContexts: ["calendar"],
        }),
      ),
    ).toBe(true);
  });

  it("matches from the legacy state.values.selectedContexts signal", () => {
    expect(
      hasAlarmContext(msg(), {
        values: { selectedContexts: ["automation"] },
      } as unknown as State),
    ).toBe(true);
  });

  it("does NOT match a non-alarm routed context", () => {
    expect(
      hasAlarmContext(msg(), stateWithRouting({ primaryContext: "chat" })),
    ).toBe(false);
  });

  it("does NOT match on alarm keyword text alone — the keyword bank is gone", () => {
    expect(
      hasAlarmContext(
        msg("please set an alarm for 7am"),
        stateWithRouting({ primaryContext: "chat" }),
      ),
    ).toBe(false);
    // Previously the multilingual ALARM_TERMS bank matched these; now: no state,
    // no routed context → no match.
    expect(hasAlarmContext(msg("wake me up / despertador / アラーム"))).toBe(
      false,
    );
  });
});

describe("resolveSubaction (structured only)", () => {
  it("prefers the explicit action discriminator", () => {
    expect(resolveSubaction({ action: "cancel", id: "x" })).toBe("cancel");
  });

  it("accepts subaction and op aliases", () => {
    expect(resolveSubaction({ subaction: "schedule" })).toBe("set");
    expect(resolveSubaction({ op: "remove", id: "x" })).toBe("cancel");
    expect(resolveSubaction({ action: "show" })).toBe("list");
  });

  it("infers set from a schedule payload shape", () => {
    expect(
      resolveSubaction({ timeIso: "2026-01-01T07:00:00Z", title: "Wake" }),
    ).toBe("set");
  });

  it("infers cancel from an id / alarmId", () => {
    expect(resolveSubaction({ id: "alarm-1" })).toBe("cancel");
    expect(resolveSubaction({ alarmId: "alarm-2" })).toBe("cancel");
  });

  it("defaults to the read-only list when nothing structured is present", () => {
    expect(resolveSubaction({})).toBe("list");
  });

  it("never parses English verbs from an unrelated text field", () => {
    expect(resolveSubaction({ note: "cancel this alarm now" })).toBe("list");
  });
});

describe("ALARM action validate", () => {
  const realPlatform = process.platform;
  const setPlatform = (value: string) =>
    Object.defineProperty(process, "platform", { value, configurable: true });
  afterEach(() =>
    Object.defineProperty(process, "platform", {
      value: realPlatform,
      configurable: true,
    }),
  );

  it("returns false on non-darwin even when routed to an alarm context", async () => {
    setPlatform("linux");
    const ok = await createAlarmAction().validate?.(
      {} as never,
      msg(),
      stateWithRouting({ primaryContext: "tasks" }),
    );
    expect(ok).toBe(false);
  });

  it("validates on darwin when routed to an alarm context", async () => {
    setPlatform("darwin");
    const ok = await createAlarmAction().validate?.(
      {} as never,
      msg(),
      stateWithRouting({ primaryContext: "calendar" }),
    );
    expect(ok).toBe(true);
  });

  it("does NOT validate on darwin from alarm keyword text without a routed context", async () => {
    setPlatform("darwin");
    const ok = await createAlarmAction().validate?.(
      {} as never,
      msg("set an alarm"),
      stateWithRouting({ primaryContext: "chat" }),
    );
    expect(ok).toBe(false);
  });
});
