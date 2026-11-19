import { describe, expect, it } from "vitest";
import type { DeviceOperation } from "./contract.ts";
import { authoredTelephonyTarget } from "./telephony-request.ts";
import {
  DeviceTelephonyTargetNotRequestedError,
  groundTelephonyTarget,
  samePhoneNumber,
  writtenPhoneNumbers,
} from "./telephony-target-grounding.ts";

const call = (number: string) =>
  ({ type: "phone_call", target: { kind: "number", number } }) as DeviceOperation;
const callContact = (query: string) =>
  ({ type: "phone_call", target: { kind: "contact", query } }) as DeviceOperation;
const dial = (number: string) =>
  ({ type: "phone_dial", target: { kind: "number", number } }) as DeviceOperation;
const text = (number: string, body: string) =>
  ({
    type: "sms_compose",
    target: { kind: "number", number },
    body,
  }) as DeviceOperation;
const send = (recipients: string[], body: string) =>
  ({ type: "sms_send", recipients, body, subscriptionId: 1 }) as DeviceOperation;

function refusal(operation: DeviceOperation, request: string) {
  try {
    groundTelephonyTarget(operation, request);
  } catch (error) {
    if (error instanceof DeviceTelephonyTargetNotRequestedError)
      return error.refusal;
    throw error;
  }
  return undefined;
}

describe("owner-written numbers", () => {
  it("reads numbers in the forms people write them", () => {
    expect(writtenPhoneNumbers("call 415-555-0100")).toEqual(["4155550100"]);
    expect(writtenPhoneNumbers("ring (415) 555-0100 now")).toEqual([
      "4155550100",
    ]);
    expect(writtenPhoneNumbers("dial +1 415.555.0100")).toEqual([
      "+14155550100",
    ]);
    expect(writtenPhoneNumbers("+44 20 7946 0958")).toEqual(["+442079460958"]);
    expect(writtenPhoneNumbers("415 555 0100 or 415 302 4399")).toEqual([
      "4155550100",
      "4153024399",
    ]);
    expect(writtenPhoneNumbers("call 911")).toEqual(["911"]);
  });

  it("does not read dates, times or words as numbers", () => {
    expect(writtenPhoneNumbers("call back about invoice 2026-11-20")).toEqual(
      [],
    );
    expect(writtenPhoneNumbers("call Maya at 5 or 6:30")).toEqual([]);
    expect(writtenPhoneNumbers("call the number in that email")).toEqual([]);
    expect(writtenPhoneNumbers("order A4155550100")).toEqual([]);
  });

  it("compares country codes and formats, not just digits", () => {
    expect(samePhoneNumber("+14155550100", "4155550100")).toBe(true);
    expect(samePhoneNumber("4155550100", "4155550100")).toBe(true);
    expect(samePhoneNumber("6505715862", "4155550100")).toBe(false);
    expect(samePhoneNumber("5550100", "4155550100")).toBe(false);
  });
});

describe("whole-message commands hand through the owner's recipient", () => {
  it("replaces the model's invented number with the owner's (v612)", () => {
    expect(
      groundTelephonyTarget(call("6505715862"), "call 415-555-0100"),
    ).toEqual({ operation: call("4155550100"), handedThrough: true });
    expect(
      groundTelephonyTarget(dial("+16505715862"), "please call (415) 555-0100"),
    ).toEqual({ operation: dial("4155550100"), handedThrough: true });
    expect(
      groundTelephonyTarget(
        text("6505715862", "v612 test"),
        "text 415-555-0100 saying v612 test",
      ).operation,
    ).toEqual(text("4155550100", "v612 test"));
    expect(
      groundTelephonyTarget(send(["+16505715862"], "hi"), "text 415-555-0100 saying hi")
        .operation,
    ).toEqual(send(["4155550100"], "hi"));
  });

  it("keeps the owner's dial form when the model added a country code", () => {
    expect(
      groundTelephonyTarget(call("+14155550100"), "call 415-555-0100").operation,
    ).toEqual(call("4155550100"));
  });

  it("hands a written name to the phone's own contact lookup", () => {
    expect(
      groundTelephonyTarget(call("6505715862"), "call my mom please"),
    ).toEqual({ operation: callContact("mom"), handedThrough: true });
    expect(
      groundTelephonyTarget(callContact("Shaw Walters"), "call shaw").operation,
    ).toEqual(callContact("shaw"));
    expect(
      groundTelephonyTarget(
        { type: "sms_compose", query: "Sam Lee", body: "late" } as DeviceOperation,
        "text Sam saying late",
      ).operation,
    ).toEqual({ type: "sms_compose", query: "Sam", body: "late" });
  });

  it("refuses a recipient no phone form can carry", () => {
    expect(
      refusal(
        { type: "sms_compose", query: "Test Alpha", body: "hi" } as DeviceOperation,
        "text 415-555-0100 saying hi",
      ),
    ).toBe("form");
    expect(refusal(send(["4153024399"], "hi"), "text shaw saying hi")).toBe(
      "form",
    );
  });
});

describe("other requests ground the model's recipient", () => {
  it("refuses a number the owner did not write", () => {
    expect(
      refusal(call("6505715862"), "can you call 415-555-0100 when you get a sec"),
    ).toBe("number");
    expect(refusal(call("6505715862"), "call the pharmacy back")).toBe("number");
    expect(refusal(call("4155550100"), "call the number in that email")).toBe(
      "number",
    );
  });

  it("keeps a number the owner wrote, in the owner's form", () => {
    expect(
      groundTelephonyTarget(
        call("+14155550100"),
        "can you call 415-555-0100 when you get a sec",
      ),
    ).toEqual({ operation: call("4155550100"), handedThrough: false });
    expect(
      groundTelephonyTarget(call("911"), "there's a fire, call 911 now")
        .operation,
    ).toEqual(call("911"));
  });

  it("accepts a contact the owner named and refuses one they did not", () => {
    expect(
      groundTelephonyTarget(callContact("Maya"), "could you ring maya's cell later")
        .operation,
    ).toEqual(callContact("Maya"));
    expect(refusal(callContact("Shaw"), "call my landlord back today")).toBe(
      "contact",
    );
    expect(refusal(callContact("4155550100"), "call 4155550100 tomorrow")).toBe(
      "contact",
    );
  });

  it("never takes an SMS recipient from the message body", () => {
    // The owner names Sam; the number is what the text says.
    expect(
      refusal(
        text("4155550100", "call me at 415-555-0100"),
        "send Sam a text: call me at 415-555-0100",
      ),
    ).toBe("number");
    expect(
      refusal(
        send(["4155550100"], "My new number is 415-555-0100."),
        "message Sam that my new number is 415-555-0100",
      ),
    ).toBe("number");
    // A recipient written outside the body still counts.
    expect(
      groundTelephonyTarget(
        text("+14153024399", "call me at 415-555-0100"),
        "send 415-302-4399 a text: call me at 415-555-0100",
      ).operation,
    ).toEqual(text("4153024399", "call me at 415-555-0100"));
    // Every recipient of a SIM send must be one the owner wrote.
    expect(
      refusal(
        send(["4155550100", "6505715862"], "hi"),
        "send a text to 415-555-0100 and say hi",
      ),
    ).toBe("number");
  });

  it("grounds a keypad prefill and allows an empty keypad", () => {
    expect(
      groundTelephonyTarget(
        { type: "phone_keypad", number: "+14155550100" } as DeviceOperation,
        "put 415 555 0100 in the dialer for me",
      ).operation,
    ).toEqual({ type: "phone_keypad", number: "4155550100" });
    expect(
      refusal(
        { type: "phone_keypad", number: "6505715862" } as DeviceOperation,
        "open the dialer with 415-555-0100",
      ),
    ).toBe("number");
    expect(
      refusal(
        { type: "phone_keypad", number: "6505715862" } as DeviceOperation,
        "open the dialer",
      ),
    ).toBe("number");
    expect(
      groundTelephonyTarget(
        { type: "phone_keypad" } as DeviceOperation,
        "open the dialer",
      ).operation,
    ).toEqual({ type: "phone_keypad" });
  });

  it("leaves other operations alone", () => {
    const op = { type: "browser_navigate", url: "https://example.com/" };
    expect(
      groundTelephonyTarget(op as DeviceOperation, "call 415-555-0100").operation,
    ).toBe(op);
  });
});

describe("authoredTelephonyTarget", () => {
  it("reads the recipient of the whole-message command", () => {
    expect(authoredTelephonyTarget("call 415-555-0100")).toEqual({
      request: "call",
      target: { kind: "number", number: "4155550100" },
    });
    expect(authoredTelephonyTarget("Call Sam Lee now.")).toEqual({
      request: "call",
      target: { kind: "contact", query: "Sam Lee" },
    });
    expect(
      authoredTelephonyTarget("text +1 (415) 555-0100 saying call me at 650"),
    ).toEqual({
      request: "text",
      target: { kind: "number", number: "+14155550100" },
    });
    expect(authoredTelephonyTarget("call it a day")).toBeUndefined();
  });
});
