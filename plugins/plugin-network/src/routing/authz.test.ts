import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectNetworkSignals } from "../evaluators/network-signals.js";
import { ownWords, quotedSpans, resolveBusyVsPaused } from "./authz.js";

describe("Network own-word boundary", () => {
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
