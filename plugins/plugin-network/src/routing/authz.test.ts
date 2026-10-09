import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectNetworkSignals } from "../evaluators/network-signals.js";
import { ownWords, resolveBusyVsPaused } from "./authz.js";

describe("Network own-word boundary", () => {
  it("keeps sanitized third-party quotes out of signals and state decisions", () => {
    const quotedOptOut =
      'My friend said "stop\u200b texting me" but I still want updates';
    const quotedSafety = "He wrote: made me uncom\u200bfortable, but I am fine";
    const repeatedQuotedOptOut = 'Do not stop texting. "stop texting"';

    assert(!ownWords(quotedOptOut).includes("stop texting"));
    assert.deepEqual(detectNetworkSignals(quotedOptOut), []);
    assert.deepEqual(detectNetworkSignals(quotedSafety), []);
    assert.deepEqual(detectNetworkSignals(repeatedQuotedOptOut), []);
    assert.equal(
      resolveBusyVsPaused("paused", 'They said "I am swam\u200bped"'),
      "paused",
    );

    assert.deepEqual(detectNetworkSignals("Please stop texting me"), [
      { kind: "opt_out", evidence: "stop texting" },
    ]);
  });
});
