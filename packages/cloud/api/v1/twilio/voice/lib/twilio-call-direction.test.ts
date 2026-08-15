/** Tests deterministic PSTN participant resolution for inbound and API calls. */

import { describe, expect, test } from "bun:test";
import { resolveTwilioCallParticipants } from "./twilio-call-direction";

describe("resolveTwilioCallParticipants", () => {
  test("uses To as the public line for an inbound call", () => {
    expect(
      resolveTwilioCallParticipants({
        direction: "inbound",
        from: "+14155550100",
        to: "+18087881821",
      }),
    ).toEqual({
      publicLineNumber: "+18087881821",
      callerNumber: "+14155550100",
      outbound: false,
    });
  });

  test("uses From as the public line for a Calls API callback", () => {
    expect(
      resolveTwilioCallParticipants({
        direction: "outbound-api",
        from: "+18087881821",
        to: "+14155550100",
      }),
    ).toEqual({
      publicLineNumber: "+18087881821",
      callerNumber: "+14155550100",
      outbound: true,
    });
  });
});
