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

describe("Network two-ended range", () => {
  it("reads the end of a range stated with to", () => {
    const now = new Date("2026-10-14T15:00:00Z"); // Wednesday
    for (const [text, from, until] of [
      ["I'm in Lisbon from Monday to Friday", "2026-10-19", "2026-10-23"],
      [
        "I'm in Lisbon from October 30 to November 2",
        "2026-10-30",
        "2026-11-02",
      ],
    ]) {
      assert.deepEqual(
        authorizeSetState(
          {
            state: "traveling",
            from: "2026-11-01",
            until: "2026-11-05",
            evidence: text,
          },
          text,
          now,
        ),
        {
          allowed: true,
          state: "traveling",
          from: `${from}T00:00:00.000Z`,
          until: `${until}T00:00:00.000Z`,
        },
        text,
      );
    }
    // "to" between two places is not a date range: the model's end stands.
    const places = "I'm flying from Boston to New York";
    assert.deepEqual(
      authorizeSetState(
        { state: "traveling", until: "2026-11-01", evidence: places },
        places,
        now,
      ),
      {
        allowed: true,
        state: "traveling",
        from: null,
        until: "2026-11-01T00:00:00.000Z",
      },
    );
    // A destination is not a start date. "from Boston to New York on Friday
    // for two weeks" must keep the duration, not end on the departure day.
    const placeRange =
      "I'm flying from Boston to New York on Friday for two weeks";
    assert.deepEqual(
      authorizeSetState(
        {
          state: "traveling",
          from: null,
          until: "2026-10-30",
          evidence: placeRange,
        },
        placeRange,
        now,
      ),
      {
        allowed: true,
        state: "traveling",
        from: "2026-10-16T00:00:00.000Z",
        until: "2026-10-30T00:00:00.000Z",
      },
    );
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

describe("Network weekday with a date", () => {
  it("ends on the stated date, not on the next weekday", () => {
    const now = new Date("2026-10-14T15:00:00Z");
    for (const [text, until] of [
      ["I'm in Lisbon until Friday, October 30", "2026-10-30"],
      ["I'm in Lisbon until Monday the 26th", "2026-10-26"],
      ["I'm in Lisbon until Thursday 10/29", "2026-10-29"],
      ["I'm in Lisbon until Friday", "2026-10-16"],
    ]) {
      assert.deepEqual(
        authorizeSetState(
          { state: "traveling", until, evidence: text },
          text,
          now,
        ),
        {
          allowed: true,
          state: "traveling",
          from: null,
          until: `${until}T00:00:00.000Z`,
        },
        text,
      );
    }
  });
});

describe("Network weekday with next week", () => {
  it("ends on the weekday of the next calendar week, not this week's", () => {
    const now = new Date("2026-10-14T15:00:00Z"); // Wednesday
    for (const [text, until] of [
      ["I'm in Lisbon until Friday next week", "2026-10-23"],
      ["I'm in Lisbon until Friday of next week", "2026-10-23"],
      ["I'm away until Monday next week", "2026-10-19"],
      // A bare weekday still means its next occurrence, this week.
      ["I'm in Lisbon until Friday", "2026-10-16"],
    ]) {
      assert.deepEqual(
        authorizeSetState(
          { state: "traveling", until, evidence: text },
          text,
          now,
        ),
        {
          allowed: true,
          state: "traveling",
          from: null,
          until: `${until}T00:00:00.000Z`,
        },
        text,
      );
    }
  });
});

describe("Network back the date", () => {
  it("ends a stay on the date after 'back the', as authz reads it", () => {
    const now = new Date("2026-10-19T15:00:00Z"); // Monday
    for (const [proposal, text, until] of [
      [
        { state: "paused", until: null, evidence: "Pause intros" },
        "Pause intros, back the 5th",
        "2026-11-05",
      ],
      [
        { state: "traveling", until: null, evidence: "I'm in Lisbon" },
        "I'm in Lisbon, back the 12th",
        "2026-11-12",
      ],
      // The member's own date wins over a wrong model date.
      [
        { state: "paused", until: "2026-10-25", evidence: "Pause intros" },
        "Pause intros, back the 5th",
        "2026-11-05",
      ],
      // The preposition forms already resolved.
      [
        { state: "paused", until: null, evidence: "Pause intros" },
        "Pause intros, back on the 5th",
        "2026-11-05",
      ],
    ] as const) {
      assert.deepEqual(
        authorizeSetState(proposal, text, now),
        {
          allowed: true,
          state: proposal.state,
          from: null,
          until: `${until}T00:00:00.000Z`,
        },
        text,
      );
    }
  });
});
