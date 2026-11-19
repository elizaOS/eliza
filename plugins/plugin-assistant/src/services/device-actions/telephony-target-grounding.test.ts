import { spokenPhoneNumbers } from "@elizaos/contracts/telephony-actions";
import { describe, expect, it } from "vitest";
import type { DeviceOperation } from "./contract.ts";
import { authoredTelephonyTarget } from "./telephony-request.ts";
import {
  DeviceTelephonyTargetNotRequestedError,
  groundTelephonyTarget,
  ownerPhoneNumbers,
  samePhoneNumber,
  swappedPhoneReferences,
  writtenPhoneNumbers,
} from "./telephony-target-grounding.ts";

const call = (number: string) =>
  ({
    type: "phone_call",
    target: { kind: "number", number },
  }) as DeviceOperation;
const callContact = (query: string) =>
  ({
    type: "phone_call",
    target: { kind: "contact", query },
  }) as DeviceOperation;
const dial = (number: string) =>
  ({
    type: "phone_dial",
    target: { kind: "number", number },
  }) as DeviceOperation;
const text = (number: string, body: string) =>
  ({
    type: "sms_compose",
    target: { kind: "number", number },
    body,
  }) as DeviceOperation;
const send = (recipients: string[], body: string) =>
  ({
    type: "sms_send",
    recipients,
    body,
    subscriptionId: 1,
  }) as DeviceOperation;

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
      groundTelephonyTarget(
        send(["+16505715862"], "hi"),
        "text 415-555-0100 saying hi",
      ).operation,
    ).toEqual(send(["4155550100"], "hi"));
  });

  it("keeps the owner's dial form when the model added a country code", () => {
    expect(
      groundTelephonyTarget(call("+14155550100"), "call 415-555-0100")
        .operation,
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
        {
          type: "sms_compose",
          query: "Sam Lee",
          body: "late",
        } as DeviceOperation,
        "text Sam saying late",
      ).operation,
    ).toEqual({ type: "sms_compose", query: "Sam", body: "late" });
  });

  it("refuses a recipient no phone form can carry", () => {
    expect(
      refusal(
        {
          type: "sms_compose",
          query: "Test Alpha",
          body: "hi",
        } as DeviceOperation,
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
      refusal(
        call("6505715862"),
        "can you call 415-555-0100 when you get a sec",
      ),
    ).toBe("number");
    expect(refusal(call("6505715862"), "call the pharmacy back")).toBe(
      "number",
    );
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
      groundTelephonyTarget(
        callContact("Maya"),
        "could you ring maya's cell later",
      ).operation,
    ).toEqual(callContact("Maya"));
    expect(refusal(callContact("Shaw"), "call my landlord back today")).toBe(
      "contact",
    );
    expect(refusal(callContact("4155550100"), "call 4155550100 tomorrow")).toBe(
      "contact",
    );
  });

  it("refuses a contact query made only of words every request has", () => {
    // The owner wrote "the", "me" and "call", but none of them names anyone.
    for (const [query, request] of [
      ["the", "please call the dentist about tomorrow"],
      ["me", "can you get someone to call me a taxi"],
      ["call", "could you call the dentist when you get a chance"],
      ["her number", "find her number and ring the dentist"],
    ])
      expect(refusal(callContact(query), request), query).toBe("contact");
    expect(
      groundTelephonyTarget(
        callContact("the dentist"),
        "please call the dentist about tomorrow",
      ).operation,
    ).toEqual(callContact("the dentist"));
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
      groundTelephonyTarget(op as DeviceOperation, "call 415-555-0100")
        .operation,
    ).toBe(op);
  });
});

describe("numbers the owner spoke", () => {
  const WORDS = "call four one five, five five five, zero one zero zero";
  const ASR_WORDS = "call four one five five five five oh one double oh";
  // On-device ASR for a spoken 415-555-0160: "for" is the digit 4.
  const ASR_DIGITS = "Call for 15. 5550160.";

  it("reads the digits of a spoken number", () => {
    expect(spokenPhoneNumbers(WORDS)).toContain("4155550100");
    expect(spokenPhoneNumbers(ASR_WORDS)).toEqual(["4155550100"]);
    expect(spokenPhoneNumbers(ASR_DIGITS)).toContain("4155550160");
    expect(spokenPhoneNumbers("four one five 555 0100")).toEqual([
      "4155550100",
    ]);
    expect(
      spokenPhoneNumbers("dial four fifteen five five five oh one hundred"),
    ).not.toContain("4155550100");
    expect(
      spokenPhoneNumbers("call four fifteen, triple five, oh one double oh"),
    ).toContain("4155550100");
    expect(spokenPhoneNumbers("nine one one")).toEqual(["911"]);
  });

  it("reads a homophone only beside other digits", () => {
    expect(spokenPhoneNumbers("text Sam to say hi")).toEqual([]);
    expect(spokenPhoneNumbers("call Sam for a minute at 5")).toEqual([]);
    expect(spokenPhoneNumbers("call me at four")).toEqual([]);
    expect(spokenPhoneNumbers("call Maya at 5 or 6:30")).toEqual([]);
    expect(spokenPhoneNumbers("order A4155550100")).toEqual([]);
    expect(
      spokenPhoneNumbers("five five five constructor seven eight nine"),
    ).toEqual(["555", "789"]);
    // A written number is still read as written.
    expect(ownerPhoneNumbers("call 415-555-0100")).toContain("4155550100");
  });

  it.each([
    ["words with pauses", WORDS, "4155550100"],
    ["oh and double", ASR_WORDS, "4155550100"],
    ["a country code", ASR_WORDS, "+14155550100"],
    ["a mixed form", "call four one five 555 0100", "4155550100"],
    ["ASR fragments", ASR_DIGITS, "4155550160"],
  ])("accepts the number spoken as %s", (_label, request, proposed) => {
    expect(groundTelephonyTarget(call(proposed), request)).toEqual({
      operation: call(proposed.replace("+1", "")),
      handedThrough: false,
    });
  });

  it("refuses a number the owner did not speak", () => {
    expect(refusal(call("6505715862"), WORDS)).toBe("number");
    expect(refusal(call("6505715862"), ASR_WORDS)).toBe("number");
    // Exact digits only: the ASR heard 0160, so 0100 has no source.
    expect(refusal(call("4155550100"), ASR_DIGITS)).toBe("number");
    expect(refusal(call("4155550101"), ASR_WORDS)).toBe("number");
    expect(refusal(call("4155550104"), "call me at four")).toBe("number");
    expect(refusal(call("4444444444"), "call me at four")).toBe("number");
  });

  it("never takes an SMS recipient from a spoken body", () => {
    const owner =
      "send Sam a text: call me at four one five five five five oh one double oh";
    expect(
      refusal(
        text(
          "4155550100",
          "call me at four one five five five five oh one double oh",
        ),
        owner,
      ),
    ).toBe("number");
    // The model wrote the body's number in digits.
    expect(refusal(text("4155550100", "Call me at 415-555-0100."), owner)).toBe(
      "number",
    );
    expect(
      refusal(send(["4155550100"], "Call me at 415-555-0100."), owner),
    ).toBe("number");
  });

  it("grounds a spoken keypad prefill", () => {
    expect(
      groundTelephonyTarget(
        { type: "phone_keypad", number: "4155550100" } as DeviceOperation,
        "open the dialer and put in four one five five five five oh one double oh",
      ).operation,
    ).toEqual({ type: "phone_keypad", number: "4155550100" });
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

  it("ends a text's recipient at the first word that starts the body", () => {
    for (const [request, query] of [
      ["text mom saying that I'm late", "mom"],
      ["text Sam saying that Bob is late", "Sam"],
      ["text mom to say that dinner is ready", "mom"],
      ["text Sam Lee saying hi", "Sam Lee"],
      ["text Sam, saying hi", "Sam"],
    ])
      expect(authoredTelephonyTarget(request), request).toEqual({
        request: "text",
        target: { kind: "contact", query },
      });
    expect(
      groundTelephonyTarget(
        {
          type: "sms_compose",
          target: { kind: "contact", query: "mom" },
          body: "I'm late",
        } as DeviceOperation,
        "text mom saying that I'm late",
      ).operation,
    ).toMatchObject({ target: { kind: "contact", query: "mom" } });
  });
});

describe("numbers the planner saw only as contact references", () => {
  const P = "__ELIZA_CONTACT_bef24c4f7d8ef444_6__";
  const entries = [
    { placeholder: P, value: "415-555-0100", kind: "phone" },
    // A credential-shaped phone (reply-protected) is not a contact reference.
    {
      placeholder: "__ELIZA_SECRET_bef24c4f7d8ef444_7__",
      value: "415-555-0199",
      kind: "phone",
    },
    {
      placeholder: "__ELIZA_CONTACT_bef24c4f7d8ef444_8__",
      value: "a@b.co",
      kind: "email",
    },
    // A number from history, not this request.
    {
      placeholder: "__ELIZA_CONTACT_bef24c4f7d8ef444_9__",
      value: "212-555-0142",
      kind: "phone",
    },
  ];
  const request = "can you call 415-555-0100 when you get a sec";
  const references = swappedPhoneReferences(entries, request);

  function refusedWith(operation: DeviceOperation, owner = request) {
    try {
      groundTelephonyTarget(operation, owner, references);
    } catch (error) {
      if (error instanceof DeviceTelephonyTargetNotRequestedError) return error;
      throw error;
    }
    throw new Error("not refused");
  }

  it("finds only this request's swapped phone numbers", () => {
    expect(references).toEqual([{ placeholder: P, number: "4155550100" }]);
    expect(swappedPhoneReferences(undefined, request)).toEqual([]);
    expect(swappedPhoneReferences(entries, "call the pharmacy")).toEqual([]);
  });

  it("refuses invented digits and tells the model to copy the reference", () => {
    for (const operation of [
      call("6505715862"),
      dial("6505715862"),
      text("6505715862", "running late"),
      send(["6505715862"], "running late"),
    ]) {
      const error = refusedWith(operation);
      expect(error.refusal).toBe("number");
      expect(error.references).toEqual([P]);
      expect(error.message).toContain(P);
      expect(error.message).toContain("verbatim");
    }
    const keypad = refusedWith({
      type: "phone_keypad",
      number: "6505715862",
    } as DeviceOperation);
    expect(keypad.message).toContain(P);
  });

  it("accepts the restored reference, with or without a country code", () => {
    // What the execution boundary hands over for P and +1P, in dial form.
    for (const number of ["4155550100", "+14155550100", "14155550100"])
      expect(
        groundTelephonyTarget(call(number), request, references).operation,
      ).toEqual(call("4155550100"));
    expect(
      groundTelephonyTarget(send(["+14155550100"], "hi"), request, references)
        .operation,
    ).toMatchObject({ recipients: ["4155550100"] });
  });

  it("never offers a number from the message body as the recipient", () => {
    const owner =
      "when you get a sec could you text Sam: call me at 415-555-0100";
    const error = (() => {
      try {
        groundTelephonyTarget(
          text("6505715862", "call me at 415-555-0100"),
          owner,
          swappedPhoneReferences(entries, owner),
        );
      } catch (caught) {
        return caught as DeviceTelephonyTargetNotRequestedError;
      }
    })();
    expect(error).toBeInstanceOf(DeviceTelephonyTargetNotRequestedError);
    expect(error?.references).toEqual([]);
    expect(error?.message).not.toContain(P);
  });

  it("accepts a contact the owner named", () => {
    const owner = "can you call Maya, she asked about 415-555-0100";
    expect(
      groundTelephonyTarget(callContact("Maya"), owner, references).operation,
    ).toEqual(callContact("Maya"));
  });

  it("keeps the plain refusal when nothing was swapped", () => {
    const plain = (() => {
      try {
        groundTelephonyTarget(call("6505715862"), "call the pharmacy back");
      } catch (caught) {
        return caught as DeviceTelephonyTargetNotRequestedError;
      }
    })();
    expect(plain?.references).toEqual([]);
    expect(plain?.message).not.toContain("__ELIZA_");
  });
});
