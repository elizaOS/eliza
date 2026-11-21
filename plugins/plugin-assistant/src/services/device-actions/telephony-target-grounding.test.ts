import { spokenPhoneNumbers } from "@elizaos/contracts/telephony-actions";
import { describe, expect, it } from "vitest";
import type { DeviceOperation } from "./contract.ts";
import {
  authoredTelephonyTarget,
  emergencyServicesRequest,
} from "./telephony-request.ts";
import {
  DeviceTelephonyTargetNotRequestedError,
  EMERGENCY_KEYPAD_REPLY,
  groundTelephonyTarget,
  namesTelephonyTarget,
  ownerPhoneNumbers,
  samePhoneNumber,
  swappedPhoneReferences,
  telephonyTargetRefusalReply,
  writesUnreadableNumber,
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

  it("cuts the body only as whole words, never inside the recipient", () => {
    const named = (query: string, body: string) =>
      ({
        type: "sms_compose",
        target: { kind: "contact", query },
        body,
      }) as DeviceOperation;
    // The body "hi" is not the "hi" in "Phil".
    for (const [query, body, request] of [
      ["Phil", "hi", "text Phil hi"],
      ["Sophia", "hi", "text Sophia hi"],
      ["Noah", "no", "message Noah: no"],
      ["Brooke", "ok", "send a text to Brooke: ok"],
      ["Sam", "hi", "text Sam hi"],
    ] as const)
      expect(
        groundTelephonyTarget(named(query, body), request).operation,
      ).toEqual(named(query, body));
    // "55" is not the "55" in "555".
    expect(
      groundTelephonyTarget(
        text("4155550100", "55"),
        "message 415-555-0100: 55",
      ).operation,
    ).toEqual(text("4155550100", "55"));
    // A body that repeats part of the recipient's number leaves the number.
    expect(
      groundTelephonyTarget(
        text("4155550100", "0100"),
        "text 415-555-0100 saying 0100",
      ).operation,
    ).toEqual(text("4155550100", "0100"));
    expect(
      groundTelephonyTarget(
        send(["4155550100"], "55"),
        "message 415-555-0100: 55",
      ).operation,
    ).toEqual(send(["4155550100"], "55"));
    // A name or number only inside the body is still refused.
    expect(
      refusal(named("Phil", "tell Phil hi"), "Sam should get: tell Phil hi"),
    ).toBe("contact");
    expect(
      refusal(
        text("4155550100", "call me at 415-555-0100"),
        "Sam should get: call me at 415-555-0100",
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
    const draft = {
      type: "sms_compose",
      target: { kind: "number", number: "4155550100" },
      body: "Hello",
      draft: true,
    } as const;
    expect(
      groundTelephonyTarget(
        draft,
        "Draft a text to four one five, five five five, oh one double oh saying hello.",
      ).operation,
    ).toEqual(draft);
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

  it("matches a written number before a spoken reading of it", () => {
    // "to 415-555-0100" also reads as a spoken 24155550100.
    const owner = "send a text to 415-555-0100: hi";
    expect(ownerPhoneNumbers(owner)).toContain("24155550100");
    for (const request of [owner, "message 415-555-0100: hi"])
      expect(
        groundTelephonyTarget(text("+14155550100", "hi"), request).operation,
      ).toEqual(text("4155550100", "hi"));
    expect(
      groundTelephonyTarget(
        call("+14155550100"),
        "place a call to 415-555-0100",
      ).operation,
    ).toEqual(call("4155550100"));
    expect(
      groundTelephonyTarget(
        send(["+14155550100"], "hi"),
        "a text for 415 555 0100 please: hi",
      ).operation,
    ).toEqual(send(["4155550100"], "hi"));
    // Two written numbers with the same last ten digits stay ambiguous.
    expect(
      refusal(call("4155550100"), "call +1 415-555-0100 or +2 415-555-0100"),
    ).toBe("number");
    expect(refusal(call("+16505715862"), owner)).toBe("number");
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

/**
 * Review (2026-11-20): "call mom again" handed "mom again" to the phone's
 * Contacts filter, which matches nobody; the owner's name is "mom".
 */
describe("a whole-message call keeps only the name the owner wrote", () => {
  it.each([
    ["call mom again", "mom", "mom"],
    ["call mom back", "mom", "mom"],
    ["call mom right now", "mom", "mom"],
    ["call mom's cell", "mom", "mom"],
    ["Call Maya's mobile please", "Maya", "Maya"],
    ["call my mom's cell", "mom", "mom"],
    ["ring Sam Lee right away", "Sam Lee", "Sam Lee"],
  ])("%s calls %s", (request, proposed, query) => {
    expect(authoredTelephonyTarget(request)?.target).toEqual({
      kind: "contact",
      query,
    });
    expect(groundTelephonyTarget(callContact(proposed), request)).toEqual({
      operation: callContact(query),
      handedThrough: true,
    });
  });

  it("never narrows a full name the owner wrote to the model's part of it", () => {
    expect(
      groundTelephonyTarget(callContact("Sam"), "call Sam Lee").operation,
    ).toEqual(callContact("Sam Lee"));
  });

  it("leaves two callees to the planner and grounds the model's one", () => {
    expect(authoredTelephonyTarget("call mom and dad")).toBeUndefined();
    expect(
      groundTelephonyTarget(callContact("mom"), "call mom and dad"),
    ).toEqual({ operation: callContact("mom"), handedThrough: false });
  });
});

/**
 * Review (2026-11-20): "call an ambulance" with 911 proposed was refused as
 * "that number isn't one you wrote", and "call emergency services" looked up a
 * contact. An emergency request always reaches the phone's keypad.
 */
describe("an emergency request reaches the phone's keypad", () => {
  const keypad = (number?: string) =>
    ({
      type: "phone_keypad",
      ...(number ? { number } : {}),
    }) as DeviceOperation;
  const emergencyKeypad = {
    operation: keypad(),
    handedThrough: false,
    emergency: true,
  };

  it.each([
    "call an ambulance",
    "call the police",
    "I need help, call emergency services now",
    "please get the fire department",
    "I need an ambulance",
    "send an ambulance to 12 Main St",
    "Help! Call the police",
    "call for an ambulance for me",
  ])("%s opens the empty keypad for any proposed number", (request) => {
    expect(emergencyServicesRequest(request)).toBe(true);
    for (const operation of [
      call("911"),
      call("112"),
      dial("911"),
      keypad("911"),
    ])
      expect(groundTelephonyTarget(operation, request)).toEqual(
        emergencyKeypad,
      );
  });

  it("keeps a written emergency number and opens the keypad for any other", () => {
    const request = "someone call 911";
    expect(emergencyServicesRequest(request)).toBe(true);
    for (const operation of [call("911"), dial("911"), keypad("911")])
      expect(groundTelephonyTarget(operation, request)).toEqual({
        operation,
        handedThrough: false,
      });
    expect(groundTelephonyTarget(call("112"), request)).toEqual(
      emergencyKeypad,
    );
  });

  it.each(["call for help", "call emergency services", "call police"])(
    "%s is not a contact lookup",
    (request) => {
      expect(authoredTelephonyTarget(request)).toBeUndefined();
      for (const query of ["for help", "emergency services", "police", "help"])
        expect(groundTelephonyTarget(callContact(query), request)).toEqual(
          emergencyKeypad,
        );
      expect(groundTelephonyTarget(call("911"), request)).toEqual(
        emergencyKeypad,
      );
    },
  );

  it("keeps the number the owner wrote as the reviewed call", () => {
    expect(groundTelephonyTarget(call("911"), "call 911")).toEqual({
      operation: call("911"),
      handedThrough: true,
    });
  });

  it.each([
    "she said she'd call the police",
    "call my emergency contact",
    "the police station number please",
    // Adversarial review (2026-11-20): these promoted the turn to the phone's
    // call route, replacing MESSAGE_SEND and VIEWS, though they ask for
    // something else or deny a need.
    "Get the police report from my email",
    "get the emergency number for Spain",
    "Send the police department an email",
    "contact the police department about my stolen bike tomorrow",
    "get the fire truck toy on amazon",
    "Call the fire department's non-emergency line",
    "call for help with my homework",
    "Read my email and get the police report",
    "I don't need an ambulance, just call mom",
  ])("does not read %s as an emergency request", (request) => {
    expect(emergencyServicesRequest(request)).toBe(false);
  });

  it("tells the owner to dial when the keypad cannot open", () => {
    expect(telephonyTargetRefusalReply("emergency")).toContain(
      "dial your local emergency number",
    );
    expect(EMERGENCY_KEYPAD_REPLY).toContain(
      "Dial your local emergency number",
    );
  });
});

/** Review (2026-11-20): "call 911" was not a whole-message call command. */
describe("short numbers are whole-message call commands", () => {
  it.each([
    ["call 911", "911"],
    ["Call 911!", "911"],
    ["dial 112", "112"],
    ["call 311", "311"],
  ])("%s calls %s", (request, number) => {
    expect(authoredTelephonyTarget(request)).toEqual({
      request: "call",
      target: { kind: "number", number },
    });
    expect(groundTelephonyTarget(call("6505715862"), request)).toEqual({
      operation: call(number),
      handedThrough: true,
    });
  });

  it.each(["call 5 people", "call 42"])(
    "leaves %s to the planner",
    (request) => {
      expect(authoredTelephonyTarget(request)).toBeUndefined();
    },
  );
});

/**
 * Review (2026-11-20): "call 415-555 0100" was refused as "that number isn't
 * one you wrote in your message". One North American number with mixed single
 * separators now reads as that number (phoneDialNumber); other forms that are
 * not one dial number ask for it again.
 */
describe("a number written with mixed separators asks for it again", () => {
  it("calls one North American number written with mixed separators", () => {
    expect(writesUnreadableNumber("call 415-555 0100", "4155550100")).toBe(
      false,
    );
    expect(
      groundTelephonyTarget(call("4155550100"), "call 415-555 0100").operation,
    ).toEqual(call("4155550100"));
  });

  it.each([
    "call 415 - 555 - 0100",
    "call (415)555 - 0100",
    "call 415/555/0100",
    "could you ring 415/555/0100 later",
  ])("%s is refused as unreadable, never as unwritten", (request) => {
    expect(writesUnreadableNumber(request, "4155550100")).toBe(true);
    expect(refusal(call("4155550100"), request)).toBe("unreadable");
    // A keypad prefill of the owner's digits is never "a number you didn't write".
    expect(
      refusal({ type: "phone_keypad", number: "4155550100" }, request),
    ).not.toBe("number");
  });

  it("refuses an invented number in a whole-message call as unreadable too", () => {
    expect(refusal(call("6505715862"), "call 415 - 555 - 0100")).toBe(
      "unreadable",
    );
  });

  it("asks for digits only and never says the owner wrote no number", () => {
    const reply = telephonyTargetRefusalReply(
      "unreadable",
      "call 415-555 0100",
    );
    expect(reply).toContain("Type the number again with digits only");
    expect(reply).not.toContain("isn't one you wrote");
  });

  it("says a message with no number has none", () => {
    expect(
      telephonyTargetRefusalReply("number", "call the pharmacy back"),
    ).toContain("your message doesn't include a phone number");
    expect(
      telephonyTargetRefusalReply("number", "can you call 415-555-0100"),
    ).toContain("isn't one you wrote");
    expect(
      telephonyTargetRefusalReply(
        "number",
        "call four one five five five five oh one double oh",
      ),
    ).toContain("isn't one you wrote");
  });

  it("keeps reading well-formed numbers", () => {
    expect(writesUnreadableNumber("call (415) 555-0100", "4155550100")).toBe(
      false,
    );
    expect(
      writesUnreadableNumber(
        "call back about invoice 2026-11-20",
        "4155550100",
      ),
    ).toBe(false);
    expect(
      refusal(call("6505715862"), "call Sam about invoice 11/20/2026"),
    ).toBe("number");
    expect(refusal(call("6505715862"), "call 415-555-0100 later")).toBe(
      "number",
    );
  });
});

describe("a contact change's numbers are the owner's", () => {
  const P = "__ELIZA_CONTACT_bef24c4f7d8ef444_6__";
  const owner = "add a contact Bob Lee 415-555-0100";
  const references = swappedPhoneReferences(
    [{ placeholder: P, value: "415-555-0100", kind: "phone" }],
    owner,
  );
  const create = (phoneNumbers: string[]) =>
    ({
      type: "contact_create",
      contact: { displayName: "Bob Lee", phoneNumbers, emailAddresses: [] },
    }) as DeviceOperation;
  const update = (part: "set" | "add" | "remove", phoneNumbers: string[]) =>
    ({
      type: "contact_update",
      query: "Bob Lee",
      [part]: { phoneNumbers },
    }) as DeviceOperation;
  function refused(operation: DeviceOperation, text = owner) {
    try {
      groundTelephonyTarget(operation, text, references);
    } catch (error) {
      if (error instanceof DeviceTelephonyTargetNotRequestedError) return error;
      throw error;
    }
    throw new Error("not refused");
  }

  it("is grounded only when it writes a number", () => {
    expect(namesTelephonyTarget(create(["4155550100"]))).toBe(true);
    expect(namesTelephonyTarget(update("add", ["4155550100"]))).toBe(true);
    expect(namesTelephonyTarget(create([]))).toBe(false);
    expect(
      namesTelephonyTarget({
        type: "contact_update",
        query: "Bob",
        add: { emailAddresses: ["bob@example.com"] },
      }),
    ).toBe(false);
    expect(namesTelephonyTarget({ type: "contact_delete", query: "Bob" })).toBe(
      false,
    );
  });

  it("refuses an invented number in a new contact or a change (v612)", () => {
    for (const operation of [
      create(["6505715862"]),
      create(["4155550100", "6505715862"]),
      update("set", ["6505715862"]),
      update("add", ["6505715862"]),
      update("remove", ["6505715862"]),
    ]) {
      const error = refused(operation);
      expect(error.refusal).toBe("number");
      expect(error.references).toEqual([P]);
    }
  });

  it("keeps the owner's number, in the owner's dial form", () => {
    expect(
      groundTelephonyTarget(create(["+14155550100"]), owner, references)
        .operation,
    ).toEqual(create(["4155550100"]));
    expect(
      groundTelephonyTarget(
        update("remove", ["4155550100", "+14155550100"]),
        "remove 415-555-0100 from Bob Lee",
      ).operation,
    ).toEqual(update("remove", ["4155550100"]));
  });

  it("leaves a message that writes no number to the owner's review", () => {
    const operation = create(["6505715862"]);
    expect(
      groundTelephonyTarget(operation, "save the pizza place as a contact")
        .operation,
    ).toBe(operation);
  });

  it("reads a number typed with mixed separators as the one number it is", () => {
    for (const written of ["415-555 0100", "415.555 0100", "+1 415-555 0100"]) {
      const said = `add Bob ${written} to my contacts`;
      const dialed = written.startsWith("+1") ? "+14155550100" : "4155550100";
      expect(writtenPhoneNumbers(said)).toEqual([dialed]);
      expect(
        groundTelephonyTarget(create(["4155550100"]), said).operation,
      ).toEqual(create([dialed]));
      expect(() => groundTelephonyTarget(create(["6505715862"]), said)).toThrow(
        DeviceTelephonyTargetNotRequestedError,
      );
    }
  });
});
