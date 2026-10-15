import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectNetworkSignals } from "../evaluators/network-signals.js";
import {
  authorizeSetState,
  ownWords,
  quotedSpans,
  resolveBusyVsPaused,
} from "./authz.js";

describe("Network own-word boundary", () => {
  it("recognizes curly contractions without accepting negated or quoted signals", () => {
    for (const apostrophe of ["‘", "’"]) {
      assert.deepEqual(detectNetworkSignals(`I${apostrophe}m in Lisbon`), [
        { kind: "travel", evidence: "I'm in Lisbon" },
      ]);
      assert.deepEqual(
        detectNetworkSignals(`Don${apostrophe}t stop texting me`),
        [],
      );
    }
    assert.deepEqual(
      detectNetworkSignals(
        "She said ‘stop texting me’ but I still want updates",
      ),
      [],
    );
    assert.deepEqual(
      detectNetworkSignals(
        "He said stop texting me and I said don’t stop texting",
      ),
      [],
    );
  });

  it("keeps third-party text out without masking the member's words", () => {
    const quotedOptOut =
      'My friend said "stop\u200b texting me" but I still want updates';
    const quotedSafety = "He wrote: made me uncom\u200bfortable, but I am fine";
    const repeatedQuotedOptOut = 'Do not stop texting. "stop texting"';
    const reportedThenOwnedOptOut =
      "He said stop texting, and I said stop texting too";

    assert(!ownWords(quotedOptOut).includes("stop texting"));
    assert.deepEqual(detectNetworkSignals(quotedOptOut), []);
    assert.deepEqual(detectNetworkSignals(quotedSafety), []);
    assert.deepEqual(detectNetworkSignals(repeatedQuotedOptOut), []);
    assert.deepEqual(detectNetworkSignals(reportedThenOwnedOptOut), [
      { kind: "opt_out", evidence: "stop texting" },
    ]);
    const reportedThenOwnedNoComma =
      "He said stop texting me and I said stop texting too";
    assert.deepEqual(quotedSpans(reportedThenOwnedNoComma), [
      "stop texting me",
    ]);
    assert.deepEqual(detectNetworkSignals(reportedThenOwnedNoComma), [
      { kind: "opt_out", evidence: "stop texting" },
    ]);
    assert.equal(
      resolveBusyVsPaused(
        "paused",
        "She said she is swamped and I said pause my intros",
      ),
      "paused",
    );
    // "and I" without a reporting verb stays inside the third party's words.
    assert.deepEqual(quotedSpans("She said pause my intros and I agree"), [
      "pause my intros and I agree",
    ]);
    assert.deepEqual(quotedSpans("She said pause and I am fine"), [
      "pause and I am fine",
    ]);
    assert.deepEqual(detectNetworkSignals("I said stop texting"), [
      { kind: "opt_out", evidence: "stop texting" },
    ]);
    assert.deepEqual(detectNetworkSignals("I've already said stop texting"), [
      { kind: "opt_out", evidence: "stop texting" },
    ]);
    assert.deepEqual(quotedSpans("he said aid"), ["aid"]);
    assert.equal(
      resolveBusyVsPaused("paused", 'They said "I am swam\u200bped"'),
      "paused",
    );

    assert.deepEqual(detectNetworkSignals("Please stop texting me"), [
      { kind: "opt_out", evidence: "stop texting" },
    ]);
    assert.deepEqual(
      detectNetworkSignals("I'm in a meeting, can we talk later?"),
      [],
    );
    assert.deepEqual(detectNetworkSignals("I will be in touch"), []);
    assert.deepEqual(detectNetworkSignals("I'm in Lisbon until Friday"), [
      { kind: "travel", evidence: "I'm in Lisbon until Friday" },
    ]);
    assert.deepEqual(detectNetworkSignals("I'M In Lisbon"), [
      { kind: "travel", evidence: "I'M In Lisbon" },
    ]);
  });
});

describe("Network stated duration", () => {
  it("counts a stated duration from the start the member gave", () => {
    const now = new Date("2026-10-14T15:00:00Z");
    for (const [text, from, until] of [
      [
        "I'm traveling to Tokyo for two weeks starting Monday",
        "2026-10-19",
        "2026-11-02",
      ],
      ["From Monday I'm in Lisbon for a week", "2026-10-19", "2026-10-26"],
      ["Heading to Paris on Nov 10 for 3 days", "2026-11-10", "2026-11-13"],
      [
        "Starting December 1st I'm traveling for a month",
        "2026-12-01",
        "2027-01-01",
      ],
    ]) {
      const decision = authorizeSetState(
        { state: "traveling", from, until, evidence: text },
        text,
        now,
      );
      assert.deepEqual(
        decision,
        {
          allowed: true,
          state: "traveling",
          from: `${from}T00:00:00.000Z`,
          until: `${until}T00:00:00.000Z`,
        },
        text,
      );
    }
  });

  it("reads the start from the member's words when the model gives none", () => {
    const now = new Date("2026-10-14T15:00:00Z");
    for (const [text, modelFrom, from, until] of [
      [
        "From Monday I'm in Lisbon for a week",
        undefined,
        "2026-10-19",
        "2026-10-26",
      ],
      [
        "I'm in Tokyo for two weeks from October 20",
        undefined,
        "2026-10-20",
        "2026-11-03",
      ],
      [
        "Starting December 1st I'm traveling for a month",
        undefined,
        "2026-12-01",
        "2027-01-01",
      ],
      [
        "Heading to Paris on Nov 10 for 3 days",
        undefined,
        "2026-11-10",
        "2026-11-13",
      ],
      // A model start that disagrees with the member's words loses.
      [
        "From Monday I'm in Lisbon for a week",
        "2026-10-14",
        "2026-10-19",
        "2026-10-26",
      ],
    ] as const) {
      const decision = authorizeSetState(
        {
          state: "traveling",
          from: modelFrom,
          until: "2026-10-30",
          evidence: text,
        },
        text,
        now,
      );
      assert.deepEqual(
        decision,
        {
          allowed: true,
          state: "traveling",
          from: `${from}T00:00:00.000Z`,
          until: `${until}T00:00:00.000Z`,
        },
        `${text} (model from ${modelFrom ?? "none"})`,
      );
    }
  });

  it("counts a duration with no start from today", () => {
    const text = "I'm in Tokyo for two weeks";
    assert.deepEqual(
      authorizeSetState(
        { state: "traveling", until: "2026-11-01", evidence: text },
        text,
        new Date("2026-10-14T15:00:00Z"),
      ),
      {
        allowed: true,
        state: "traveling",
        from: null,
        until: "2026-10-28T00:00:00.000Z",
      },
    );
  });
});
