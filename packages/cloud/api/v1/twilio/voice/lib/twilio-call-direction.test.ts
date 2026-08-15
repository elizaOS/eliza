/** Tests deterministic PSTN participant resolution for inbound and API calls. */

import { describe, expect, test } from "bun:test";
import { resolveTwilioCallParticipants } from "./twilio-call-direction";

describe("resolveTwilioCallParticipants", () => {
  test("uses To as the public line for an inbound call", () => {
    expect(
      resolveTwilioCallParticipants({
        direction: "inbound",
        from: "+14155550100",
        to: "+14484080429",
      }),
    ).toEqual({
      publicLineNumber: "+14484080429",
      callerNumber: "+14155550100",
      outbound: false,
    });
  });

  test("uses From as the public line for a Calls API callback", () => {
    expect(
      resolveTwilioCallParticipants({
        direction: "outbound-api",
        from: "+14484080429",
        to: "+14155550100",
      }),
    ).toEqual({
      publicLineNumber: "+14484080429",
      callerNumber: "+14155550100",
      outbound: true,
    });
  });
});
