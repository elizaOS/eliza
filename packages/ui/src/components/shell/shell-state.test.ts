// Unit coverage for selectVisibleShellMessages — the pure selector that windows
// the rendered shell transcript (dropping empty turns except an in-flight
// assistant turn while responding, capped at MAX_RENDERED_SHELL_MESSAGES).
// Pure reducer/selector, no harness.
import { describe, expect, it } from "vitest";
import type { ShellMessage, ShellPhase } from "./shell-state";
import {
  MAX_RENDERED_SHELL_MESSAGES,
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
