// Unit coverage for selectVisibleShellMessages — the pure selector that windows
// the rendered shell transcript (dropping empty turns except an in-flight
// assistant turn while responding, capped at MAX_RENDERED_SHELL_MESSAGES).
// Pure reducer/selector, no harness.
import { describe, expect, it } from "vitest";
import type { ShellMessage, ShellPhase } from "./shell-state";
import {
  filterRenderableShellMessages,
  MAX_LOADED_SHELL_WINDOW,
  MAX_RENDERED_SHELL_MESSAGES,
  planScrollTopLoadOlder,
  SHELL_RENDER_WINDOW_STEP,
  selectVisibleShellMessages,
} from "./shell-state";

function msg(
  id: string,
  role: ShellMessage["role"],
  content: string,
): ShellMessage {
  return { id, role, content, createdAt: 0 };
}

describe("selectVisibleShellMessages (#9141 gap 4 windowing)", () => {
  it("drops empty turns when not responding", () => {
    const out = selectVisibleShellMessages(
      [
        msg("u1", "user", "hi"),
        msg("a1", "assistant", "   "),
        msg("u2", "user", ""),
        msg("a2", "assistant", "answer"),
      ],
      "idle",
    );
    expect(out.map((m) => m.id)).toEqual(["u1", "a2"]);
  });

  it("keeps an empty in-flight assistant turn while responding", () => {
    const out = selectVisibleShellMessages(
      [msg("u1", "user", "hi"), msg("a1", "assistant", "")],
      "responding",
    );
    expect(out.map((m) => m.id)).toEqual(["u1", "a1"]);
  });

  it("drops the empty assistant turn once the phase leaves responding", () => {
    const thread = [msg("u1", "user", "hi"), msg("a1", "assistant", "")];
    expect(
      selectVisibleShellMessages(thread, "responding").map((m) => m.id),
    ).toEqual(["u1", "a1"]);
    expect(selectVisibleShellMessages(thread, "idle").map((m) => m.id)).toEqual(
      ["u1"],
    );
  });

  it("does NOT keep an empty USER turn even while responding", () => {
    const out = selectVisibleShellMessages(
      [msg("u1", "user", ""), msg("a1", "assistant", "")],
      "responding",
    );
    expect(out.map((m) => m.id)).toEqual(["a1"]);
  });

  it("keeps only the most recent `max` non-empty turns", () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      msg(`m${i}`, i % 2 === 0 ? "user" : "assistant", `t${i}`),
    );
    const out = selectVisibleShellMessages(many, "idle", 3);
    expect(out.map((m) => m.id)).toEqual(["m7", "m8", "m9"]);
  });

  it("counts the cap AFTER dropping empties (cap applies to rendered turns)", () => {
    const out = selectVisibleShellMessages(
      [
        msg("e1", "assistant", "  "),
        msg("k1", "user", "a"),
        msg("e2", "user", ""),
        msg("k2", "assistant", "b"),
        msg("k3", "user", "c"),
      ],
      "idle",
      2,
    );
    expect(out.map((m) => m.id)).toEqual(["k2", "k3"]);
  });

  it("returns all turns when under the cap and never mutates the input", () => {
    const input = [msg("u1", "user", "hi"), msg("a1", "assistant", "yo")];
    const frozen = Object.freeze([...input]) as readonly ShellMessage[];
    const out = selectVisibleShellMessages(frozen, "idle");
    expect(out.map((m) => m.id)).toEqual(["u1", "a1"]);
    expect(out).not.toBe(input);
  });

  it("defaults to the exported render cap", () => {
    expect(MAX_RENDERED_SHELL_MESSAGES).toBe(80);
    const big = Array.from({ length: 100 }, (_, i) =>
      msg(`m${i}`, "user", `t${i}`),
    );
    expect(selectVisibleShellMessages(big, "idle")).toHaveLength(80);
  });

  it("is exhaustive over ShellPhase for the empty-assistant exception", () => {
    const phases: ShellPhase[] = [
      "booting",
      "idle",
      "summoned",
      "listening",
      "responding",
    ];
    const thread = [msg("u1", "user", "hi"), msg("a1", "assistant", "")];
    for (const phase of phases) {
      const ids = selectVisibleShellMessages(thread, phase).map((m) => m.id);
      expect(ids).toEqual(phase === "responding" ? ["u1", "a1"] : ["u1"]);
    }
  });

  it("keeps an image-only USER turn (no caption) in every phase", () => {
    const imageOnly: ShellMessage = {
      ...msg("u1", "user", ""),
      attachments: [
        { id: "att1", url: "/api/media/abc.png", contentType: "image" },
      ],
    };
    const phases: ShellPhase[] = [
      "booting",
      "idle",
      "summoned",
      "listening",
      "responding",
    ];
    for (const phase of phases) {
      const ids = selectVisibleShellMessages(
        [imageOnly, msg("a1", "assistant", "nice photo")],
        phase,
      ).map((m) => m.id);
      expect(ids).toEqual(["u1", "a1"]);
    }
  });

  it("keeps an attachment-only ASSISTANT turn after the phase leaves responding", () => {
    const generated: ShellMessage = {
      ...msg("a1", "assistant", ""),
      attachments: [
        { id: "att1", url: "/api/media/gen.png", contentType: "image" },
      ],
    };
    const thread = [msg("u1", "user", "draw me a cat"), generated];
    // Visible while streaming AND once settled — it must not vanish.
    expect(
      selectVisibleShellMessages(thread, "responding").map((m) => m.id),
    ).toEqual(["u1", "a1"]);
    expect(selectVisibleShellMessages(thread, "idle").map((m) => m.id)).toEqual(
      ["u1", "a1"],
    );
  });

  it("keeps a secret-request-only turn (actionable block, no text)", () => {
    const secret: ShellMessage = {
      ...msg("a1", "assistant", ""),
      secretRequest: { key: "DISCORD_TOKEN", status: "pending" },
    };
    expect(
      selectVisibleShellMessages(
        [msg("u1", "user", "connect discord"), secret],
        "idle",
      ).map((m) => m.id),
    ).toEqual(["u1", "a1"]);
  });

  it("keeps a content-less FAILED assistant turn (its retry / gate UI must render)", () => {
    const failed: ShellMessage = {
      ...msg("a1", "assistant", ""),
      failureKind: "rate_limited",
    };
    // Kept in every phase — a rate-limit/provider stall fails before any token
    // streams, so a content check alone would hide the failure + its retry.
    expect(
      selectVisibleShellMessages([msg("u1", "user", "hi"), failed], "idle").map(
        (m) => m.id,
      ),
    ).toEqual(["u1", "a1"]);
  });

  it("still drops turns with an EMPTY attachments array", () => {
    const emptyAtt: ShellMessage = {
      ...msg("a1", "assistant", ""),
      attachments: [],
    };
    expect(
      selectVisibleShellMessages(
        [msg("u1", "user", "hi"), emptyAtt],
        "idle",
      ).map((m) => m.id),
    ).toEqual(["u1"]);
  });
});

describe("filterRenderableShellMessages", () => {
  it("returns the same renderable set selectVisibleShellMessages keeps, uncapped", () => {
    const thread = Array.from({ length: 300 }, (_, i) =>
      i % 5 === 0
        ? msg(`e${i}`, "assistant", "  ") // empty → dropped
        : msg(`m${i}`, i % 2 === 0 ? "user" : "assistant", `t${i}`),
    );
    const renderable = filterRenderableShellMessages(thread, "idle");
    // No cap here — every non-empty turn survives (240 of 300).
    expect(renderable).toHaveLength(240);
    // The capped selector is exactly the tail of the uncapped renderable set.
    expect(selectVisibleShellMessages(thread, "idle").map((m) => m.id)).toEqual(
      renderable.slice(-MAX_RENDERED_SHELL_MESSAGES).map((m) => m.id),
    );
  });
});

// Regression guard for #14329: the overlay's render window MUST grow past the
// initial cap so scroll-up reveals older turns instead of dead-ending at 80.
// Before this change the overlay rendered a fixed slice(-80); load-older loaded
// pages into state that the cap immediately sliced back off, so scroll-up was
// silently dead. This is the pure policy that overlay wiring drives.
describe("planScrollTopLoadOlder (#14329 sliding render window)", () => {
  it("reveals already-loaded turns first — grows a page, no fetch", () => {
    // 200 loaded, window at the initial 80: there are 120 loaded-but-hidden
    // turns, so a scroll-to-top must GROW the window (not hit the network).
    const plan = planScrollTopLoadOlder(MAX_RENDERED_SHELL_MESSAGES, 200, true);
    expect(plan.shouldFetch).toBe(false);
    expect(plan.nextWindowSize).toBe(
      MAX_RENDERED_SHELL_MESSAGES + SHELL_RENDER_WINDOW_STEP,
    );
  });

  it("never grows the window past the loaded count", () => {
    // 90 loaded, window 80: one more step would overshoot to 130, so clamp to
    // the 90 that actually exist.
    const plan = planScrollTopLoadOlder(MAX_RENDERED_SHELL_MESSAGES, 90, true);
    expect(plan.shouldFetch).toBe(false);
    expect(plan.nextWindowSize).toBe(90);
  });

  it("fetches once the window has consumed every loaded turn", () => {
    // window == loaded: nothing left to reveal, so page the next older server
    // window when the server reports more.
    const plan = planScrollTopLoadOlder(120, 120, true);
    expect(plan.shouldFetch).toBe(true);
    expect(plan.nextWindowSize).toBe(120);
  });

  it("does NOT fetch when the window is drained and the server has no more", () => {
    const plan = planScrollTopLoadOlder(120, 120, false);
    expect(plan.shouldFetch).toBe(false);
    expect(plan.nextWindowSize).toBe(120);
  });

  it("latches off at the DOM bound — neither grows nor fetches", () => {
    // At the bound, more history may exist in state and on the server, but the
    // window must not grow (bounded DOM) and must not spin the fetch loop.
    const plan = planScrollTopLoadOlder(
      MAX_LOADED_SHELL_WINDOW,
      MAX_LOADED_SHELL_WINDOW + 500,
      true,
    );
    expect(plan.shouldFetch).toBe(false);
    expect(plan.nextWindowSize).toBe(MAX_LOADED_SHELL_WINDOW);
  });

  it("never grows past the DOM bound even mid-reveal", () => {
    const plan = planScrollTopLoadOlder(
      MAX_LOADED_SHELL_WINDOW - 10,
      MAX_LOADED_SHELL_WINDOW + 500,
      true,
    );
    expect(plan.shouldFetch).toBe(false);
    expect(plan.nextWindowSize).toBe(MAX_LOADED_SHELL_WINDOW);
  });

  it("walks a >200-turn thread from the initial cap to full history", () => {
    // Simulate the real scroll-up loop: repeatedly apply the policy, growing to
    // reveal loaded turns then paging older ones, and assert it terminates at
    // the DOM bound having surfaced far more than the initial 80.
    let windowSize = MAX_RENDERED_SHELL_MESSAGES;
    let loaded = 200; // initial server window
    const serverPages = 6; // 6 older pages of 50 available beyond the first 200
    let pagesLeft = serverPages;
    let fetches = 0;
    for (let i = 0; i < 100; i++) {
      const plan = planScrollTopLoadOlder(windowSize, loaded, pagesLeft > 0);
      if (plan.nextWindowSize === windowSize && !plan.shouldFetch) break;
      windowSize = plan.nextWindowSize;
      if (plan.shouldFetch) {
        fetches += 1;
        const page = 50;
        loaded += page;
        windowSize = Math.min(windowSize + page, MAX_LOADED_SHELL_WINDOW);
        pagesLeft -= 1;
      }
    }
    expect(windowSize).toBe(MAX_LOADED_SHELL_WINDOW);
    expect(fetches).toBeGreaterThan(0);
    // The window reached far beyond the dead-end-at-80 wall this issue fixes.
    expect(windowSize).toBeGreaterThan(MAX_RENDERED_SHELL_MESSAGES);
  });
});
