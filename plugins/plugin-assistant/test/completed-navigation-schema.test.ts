import { describe, expect, it, vi } from "vitest";
import { validateCameraCaptureResult } from "../src/services/device-actions/camera-contract.ts";

const state = vi.hoisted(() => ({ turn: undefined as any }));
vi.mock("../src/services/device-actions/service.ts", () => ({
  getDeviceActionTurn: () => state.turn,
  deviceAppRecordOperationAvailable: () => true,
  DeviceActionService: class {},
}));

import {
  deviceActionForCapabilities,
  proposeDeviceAction,
  withDialNumber,
} from "../src/services/device-actions/action";
import {
  deviceOperationFormSupported,
  validateDevicePayload,
} from "../src/services/device-actions/contract";

const metadata = {
  viewDelivery: "completed-action",
  viewClientId: "11111111-1111-4111-8111-111111111111",
};
const types = (action: any) =>
  action.parameters
    .find((p: any) => p.name === "operation")
    .schema.anyOf.flatMap((b: any) => b.properties?.type?.enum ?? []);
describe("renderer-owned navigation tool selection", () => {
  it("uses canonical VIEWS instead of approval open_view without dropping writes", () => {
    const before = types(
      deviceActionForCapabilities(proposeDeviceAction, [
        "notes.local-record.v1",
      ]),
    );
    const next = deviceActionForCapabilities(
      proposeDeviceAction,
      ["notes.local-record.v1"],
      metadata,
    );
    expect(before).toContain("open_view");
    expect(types(next)).not.toContain("open_view");
    expect(types(next)).toEqual(
      before.filter((x: string) => x !== "open_view"),
    );
    expect(next.description).toContain("VIEWS");
    expect(types(proposeDeviceAction)).toContain("open_view");
  });
  it.each([
    undefined,
    {},
    { viewDelivery: "completed-action" },
    { ...metadata, viewClientId: "bad uuid" },
    { ...metadata, viewDelivery: "other" },
  ])("keeps legacy schema without a bound current renderer %j", (value) => {
    expect(
      types(
        deviceActionForCapabilities(
          proposeDeviceAction,
          ["notes.local-record.v1"],
          value,
        ),
      ),
    ).toContain("open_view");
  });
  it("leaves unrelated tools and registered schema untouched", () => {
    const original = JSON.stringify(proposeDeviceAction.parameters);
    const action = { name: "OTHER" } as any;
    expect(deviceActionForCapabilities(action, [], metadata)).toBe(action);
    deviceActionForCapabilities(proposeDeviceAction, [], metadata);
    expect(JSON.stringify(proposeDeviceAction.parameters)).toBe(original);
  });
});

it("refuses the obsolete proposal handler before creating an approval for a bound renderer", async () => {
  const runtime = {} as any;
  state.turn = { runtime };
  try {
    const result = await proposeDeviceAction.handler(
      runtime,
      { content: { metadata } } as any,
      {} as any,
      {
        parameters: { operation: { type: "open_view", view: "camera" } },
      } as any,
    );
    expect(result).toMatchObject({ success: false });
    expect(result.text).toContain("VIEWS");
  } finally {
    state.turn = undefined;
  }
});
it("preserves exact requesting message in payload and rejects malformed identifiers", () => {
  const p = {
    action: "device_action",
    version: 1,
    installationId: "installation",
    enrollmentId: "enrollment",
    operation: { type: "open_view", view: "camera" },
  };
  expect(
    validateDevicePayload({
      ...p,
      requestMessageId: "11111111-1111-4111-8111-111111111111",
    }).requestMessageId,
  ).toBe("11111111-1111-4111-8111-111111111111");
  expect(validateDevicePayload(p).requestMessageId).toBeUndefined();
  expect(() =>
    validateDevicePayload({ ...p, requestMessageId: "bad id" }),
  ).toThrow();
});

it("offers camera capture only when the device negotiated it", () => {
  expect(
    types(deviceActionForCapabilities(proposeDeviceAction, undefined)),
  ).not.toContain("camera_capture_photo");
  expect(
    types(deviceActionForCapabilities(proposeDeviceAction, [])),
  ).not.toContain("camera_capture_photo");
  expect(
    types(
      deviceActionForCapabilities(proposeDeviceAction, [
        "camera.capture-photo.v1",
      ]),
    ).filter((type: string) => type === "camera_capture_photo"),
  ).toHaveLength(1);
  expect(
    validateDevicePayload({
      action: "device_action",
      version: 1,
      installationId: "device",
      enrollmentId: "enrollment",
      operation: { type: "camera_capture_photo" },
    }).operation,
  ).toEqual({ type: "camera_capture_photo" });
  expect(() =>
    validateDevicePayload({
      action: "device_action",
      version: 1,
      installationId: "device",
      enrollmentId: "enrollment",
      operation: { type: "camera_capture_photo", upload: true },
    }),
  ).toThrow();
});

it("offers a camera lens and an SMS target only to a phone that negotiated them", () => {
  const branches = (capabilities: string[], type: string) =>
    deviceActionForCapabilities(proposeDeviceAction, capabilities)
      .parameters!.find((p: any) => p.name === "operation")!
      .schema.anyOf!.filter((b: any) => b.properties?.type?.enum?.[0] === type);
  const base = ["camera.capture-photo.v1", "sms.compose.v1"];
  const older = deviceActionForCapabilities(proposeDeviceAction, base);
  expect(branches(base, "camera_capture_photo")).toHaveLength(1);
  expect(
    branches(base, "camera_capture_photo")[0].properties,
  ).not.toHaveProperty("lens");
  expect(branches(base, "sms_compose")).toHaveLength(1);
  expect(branches(base, "sms_compose")[0].properties).toHaveProperty("query");
  // Opening Camera is not the capture, and the phone opens Camera itself.
  expect(older.description).toContain(
    "Opening the Camera view with VIEWS never takes a photo",
  );
  expect(older.description).toContain(
    "the requesting phone opens Camera itself",
  );
  expect(older.description).not.toContain("camera.capture-lens.v1");
  expect(older.description).not.toContain("sms.compose.v2");
  const next = [...base, "camera.capture-lens.v1", "sms.compose.v2"];
  const newer = deviceActionForCapabilities(proposeDeviceAction, next);
  expect(branches(next, "camera_capture_photo")).toHaveLength(1);
  expect(
    branches(next, "camera_capture_photo")[0].properties!.lens.enum,
  ).toEqual(["front", "back"]);
  expect(branches(next, "sms_compose")).toHaveLength(1);
  expect(branches(next, "sms_compose")[0].properties).toHaveProperty("target");
  expect(branches(next, "sms_compose")[0].properties).toHaveProperty("draft");
  expect(newer.description).toContain("front for a selfie");
  expect(newer.description).toContain("sms_compose {target, body}");
  expect(newer.description).not.toContain("sms_compose {query, body}");
  const payload = (operation: unknown) =>
    validateDevicePayload({
      action: "device_action",
      version: 1,
      installationId: "device",
      enrollmentId: "enrollment",
      operation,
    }).operation;
  const selfie = { type: "camera_capture_photo", lens: "front" };
  expect(payload(selfie)).toEqual(selfie);
  expect(() =>
    payload({ type: "camera_capture_photo", lens: "wide" }),
  ).toThrow();
  expect(deviceOperationFormSupported(payload(selfie), base)).toBe(false);
  expect(deviceOperationFormSupported(payload(selfie), next)).toBe(true);
  expect(
    deviceOperationFormSupported(
      payload({ type: "camera_capture_photo" }),
      base,
    ),
  ).toBe(true);
});

it("offers contact_update with add and remove only to a phone that negotiated contacts.write.v2", () => {
  const branches = (capabilities: string[]) =>
    deviceActionForCapabilities(proposeDeviceAction, capabilities)
      .parameters!.find((p: any) => p.name === "operation")!
      .schema.anyOf!.filter(
        (b: any) => b.properties?.type?.enum?.[0] === "contact_update",
      );
  const base = ["contacts.write.v1"];
  const next = [...base, "contacts.write.v2"];
  expect(branches(base)).toHaveLength(1);
  expect(branches(base)[0].properties).not.toHaveProperty("add");
  expect(branches(base)[0].required).toContain("set");
  expect(branches(next)).toHaveLength(1);
  expect(branches(next)[0].properties).toHaveProperty("add");
  expect(branches(next)[0].properties).toHaveProperty("remove");
  expect(branches(next)[0].required).toEqual(["type", "query"]);
  const newer = deviceActionForCapabilities(
    proposeDeviceAction,
    next,
  ).description;
  expect(newer).toContain("Use add when the owner asks to add a number");
  expect(newer).not.toContain("This phone cannot add one number");
  const payload = (operation: unknown) =>
    validateDevicePayload({
      action: "device_action",
      version: 1,
      installationId: "device",
      enrollmentId: "enrollment",
      operation,
    }).operation;
  const addEmail = {
    type: "contact_update",
    query: "Sam",
    add: { emailAddresses: ["sam@example.com"] },
  };
  expect(payload(addEmail)).toEqual(addEmail);
  expect(deviceOperationFormSupported(payload(addEmail), base)).toBe(false);
  expect(deviceOperationFormSupported(payload(addEmail), next)).toBe(true);
  expect(
    deviceOperationFormSupported(
      payload({
        type: "contact_update",
        query: "Sam",
        set: { phoneNumbers: [] },
      }),
      base,
    ),
  ).toBe(true);
});

it("accepts the browser camera's 25-digit saved identity without numeric coercion", () => {
  const mediaId = "1792274767123" + "123456789012";
  const result = {
    version: 1,
    kind: "camera_capture_photo",
    operationId: "operation-one",
    mediaId,
    width: 640,
    height: 480,
    mime: "image/jpeg",
  };
  expect(validateCameraCaptureResult(result).mediaId).toBe(mediaId);
  expect(() =>
    validateCameraCaptureResult({ ...result, mediaId: mediaId + "0" }),
  ).toThrow();
});

it("Gmail policy negotiation does not widen a clock-only device", () => {
  const restricted = deviceActionForCapabilities(proposeDeviceAction, [
    "clock.handoff.v1",
    "gmail.request-policy.v1",
  ]);
  expect(types(restricted)).not.toContain("create_note");
  expect(types(restricted)).not.toContain("open_view");
  expect(types(restricted)).toContain("clock_handoff");
});

it("describes only the operations this connection's schema offers", () => {
  const notesOnly = deviceActionForCapabilities(proposeDeviceAction, [
    "notes.local-record.v1",
  ]).description;
  for (const absent of [
    "sms_send",
    "phone_dial",
    "notes_named",
    "notes_search",
    "notes_query",
    "camera_capture_photo",
  ])
    expect(notesOnly).not.toContain(absent);
  expect(notesOnly).toContain("Notes read-selected/update/delete");
  const withSms = deviceActionForCapabilities(proposeDeviceAction, [
    "notes.local-record.v1",
    "sms.send.v1",
  ]).description;
  expect(withSms).toContain("Reviewed SIM SMS requires sms.send.v1");
});

it("offers each telephony action only with its own capability and states its limits", () => {
  const telephony = {
    "phone.call.v1": ["phone_call"],
    "contacts.write.v1": ["contact_create", "contact_update", "contact_delete"],
    "contacts.show.v1": ["contact_show"],
    "contacts.read.v1": ["contact_read_selected"],
    "sms.compose.v1": ["sms_compose", "sms_reply_selected"],
    "messages.read.v1": ["messages_read_selected"],
    "sms.latest-sender.v1": ["sms_latest_sender"],
    "voicemail.read.v1": ["voicemail_read_selected"],
    "voicemail.delete.v1": ["voicemail_delete_selected"],
    "phone.keypad.v1": ["phone_keypad"],
  };
  const all = Object.values(telephony).flat();
  for (const capabilities of [
    undefined,
    ["notes.local-record.v1"],
    ["phone.dial.v1", "contacts.lookup.v1", "sms.send.v1"],
  ]) {
    const offered = deviceActionForCapabilities(
      proposeDeviceAction,
      capabilities,
    );
    for (const type of all) {
      expect(types(offered)).not.toContain(type);
      expect(offered.description).not.toContain(type);
    }
  }
  for (const [capability, own] of Object.entries(telephony)) {
    const offered = types(
      deviceActionForCapabilities(proposeDeviceAction, [
        "notes.local-record.v1",
        capability,
      ]),
    );
    for (const type of all)
      expect(offered.includes(type)).toBe(own.includes(type));
  }
  const text = deviceActionForCapabilities(proposeDeviceAction, [
    "notes.local-record.v1",
    ...Object.keys(telephony),
  ]).description;
  for (const required of [
    "phone_call places a call only after the owner approves",
    "never report a connected, answered or completed call",
    "hands it to the system dialer",
    "query names the contact by search text",
    "never the address book",
    "Use sms_send instead when the exact number is known",
    "An unknown outcome must never be automatically retried",
    "sms_reply_selected {body} takes only body",
    "prefer it over sms_compose whenever the owner is talking about the open conversation",
    "Typically call messages_read_selected first",
    "never a sent message",
    "return only what the owner has open in front",
    "never use them to enumerate",
    "you receive only shown or not-found, never a name, number or count",
    "returns only the one contact the owner has open in Contacts",
    "This phone cannot add one number or email address to a contact",
    "phone_keypad {number?} (phone.keypad.v1) opens the Phone keypad",
    "It never dials or calls: the owner taps Call there.",
    "It proposes a reviewed read of one sender number suffix only.",
  ])
    expect(text).toContain(required);
  expect(text).not.toContain("contacts.write.v2");
  for (const operation of [
    { type: "phone_call", target: { kind: "contact", query: "Ada" } },
    { type: "contact_delete", query: "Ada" },
    { type: "contact_show", query: "Ada" },
    { type: "contact_read_selected" },
    { type: "sms_compose", query: "Ada", body: "Late." },
    { type: "sms_reply_selected", body: "Late." },
    { type: "messages_read_selected" },
    { type: "voicemail_read_selected" },
    { type: "voicemail_delete_selected" },
    { type: "phone_keypad" },
    { type: "phone_keypad", number: "+14155550100" },
  ])
    expect(
      validateDevicePayload({
        action: "device_action",
        version: 1,
        installationId: "device",
        enrollmentId: "enrollment",
        operation,
      }).operation,
    ).toEqual(operation);
  for (const operation of [
    {
      type: "phone_call",
      target: { kind: "number", number: "911", now: true },
    },
    { type: "messages_read_selected", threadId: "4" },
    { type: "sms_reply_selected", body: "Late.", query: "Ada" },
    { type: "sms_reply_selected", body: "Late.", threadId: "4" },
    { type: "sms_reply_selected", body: " " },
    { type: "contact_update", query: "Ada", set: {} },
    { type: "contact_update", query: "Ada", add: { phoneNumbers: [] } },
    { type: "contact_show", query: "Ada", limit: 5 },
    { type: "contact_read_selected", query: "Ada" },
    { type: "phone_keypad", number: "415-555-0100" },
    { type: "phone_keypad", number: "" },
    { type: "phone_keypad", number: "4155550100", call: true },
    { type: "phone_keypad", target: { kind: "number", number: "4155550100" } },
  ])
    expect(() =>
      validateDevicePayload({
        action: "device_action",
        version: 1,
        installationId: "device",
        enrollmentId: "enrollment",
        operation,
      }),
    ).toThrow();
});

it("offers each Browser control only with its own capability and validates its exact form", () => {
  const browser = {
    "browser.search.v1": ["browser_search"],
    "browser.tabs.v1": [
      "browser_tab_new",
      "browser_tab_switch",
      "browser_tab_close",
    ],
    "browser.find.v1": ["browser_find"],
    "browser.history.v1": ["browser_history"],
  };
  const all = Object.values(browser).flat();
  for (const capabilities of [undefined, ["notes.local-record.v1"]]) {
    const offered = deviceActionForCapabilities(
      proposeDeviceAction,
      capabilities,
    );
    for (const type of all) {
      expect(types(offered)).not.toContain(type);
      expect(offered.description).not.toContain(type);
    }
  }
  for (const [capability, own] of Object.entries(browser)) {
    const offered = deviceActionForCapabilities(proposeDeviceAction, [
      "notes.local-record.v1",
      capability,
    ]);
    for (const type of all)
      expect(types(offered).includes(type)).toBe(own.includes(type));
    expect(offered.description).toContain(capability);
  }
  const text = deviceActionForCapabilities(proposeDeviceAction, [
    "notes.local-record.v1",
    ...Object.keys(browser),
  ]).description;
  for (const required of [
    "query must be words the user typed in this message",
    "You never receive the list of tabs, a title or an address",
    "Closing a tab is always reviewed by the owner",
    "You receive no match count and no page content",
  ])
    expect(text).toContain(required);
  const operation = (value: unknown) =>
    validateDevicePayload({
      action: "device_action",
      version: 1,
      installationId: "device",
      enrollmentId: "enrollment",
      operation: value,
    }).operation;
  for (const value of [
    { type: "browser_search", query: "best pizza near me" },
    { type: "browser_tab_new" },
    { type: "browser_tab_new", private: true },
    { type: "browser_tab_switch", target: "bbc" },
    { type: "browser_tab_close" },
    { type: "browser_tab_close", target: "bbc" },
    { type: "browser_find", text: "refund" },
    { type: "browser_history", action: "stop" },
  ])
    expect(operation(value)).toEqual(value);
  for (const value of [
    { type: "browser_search", query: " " },
    { type: "browser_search", query: "cats", engine: "https://evil.example" },
    { type: "browser_search", query: "x".repeat(513) },
    { type: "browser_tab_new", private: "yes" },
    { type: "browser_tab_switch" },
    { type: "browser_tab_switch", target: "bbc", id: "3" },
    { type: "browser_tab_close", target: "a\nb" },
    { type: "browser_find", text: "" },
    { type: "browser_history", action: "home" },
  ])
    expect(() => operation(value)).toThrow("Invalid Browser operation");
  // A typed http:// address is stored as HTTPS.
  expect(
    operation({ type: "browser_navigate", url: "http://example.com:80/a" }),
  ).toEqual({ type: "browser_navigate", url: "https://example.com/a" });
  // A port typed with http:// serves plain HTTP, so it is refused.
  expect(() =>
    operation({ type: "browser_navigate", url: "http://example.com:8080/a" }),
  ).toThrow("Only HTTPS browser destinations are supported");
});

it("offers PROPOSE_DEVICE_ACTION to phone and messaging turns and summarizes it for discovery", () => {
  // v609: a text routed as messaging and a call routed as phone never saw the
  // device tool, and its discovery index row had an empty summary.
  for (const context of ["general", "contacts", "phone", "messaging"])
    expect(proposeDeviceAction.contexts).toContain(context);
  const summary = proposeDeviceAction.descriptionCompressed ?? "";
  for (const word of ["call", "SMS", "keypad", "contacts"])
    expect(summary).toContain(word);
  expect(
    deviceActionForCapabilities(proposeDeviceAction, ["phone.call.v1"])
      .descriptionCompressed,
  ).toBe(summary);
});

it("reviews a number the owner wrote with separators in its exact dial form", () => {
  // The owner's "415-555-0100" reaches the tool through a contact reference
  // that restores it exactly as typed; contact numbers were refused before.
  expect(
    withDialNumber({
      type: "contact_create",
      contact: {
        displayName: "Alpha Device Test",
        phoneNumbers: ["415-555-0100"],
        emailAddresses: [],
      },
    }),
  ).toEqual({
    type: "contact_create",
    contact: {
      displayName: "Alpha Device Test",
      phoneNumbers: ["4155550100"],
      emailAddresses: [],
    },
  });
  expect(
    withDialNumber({
      type: "contact_update",
      query: "Ada",
      add: { phoneNumbers: ["(415) 555-0100"] },
      remove: { phoneNumbers: ["+1 415.555.0199"] },
    }),
  ).toEqual({
    type: "contact_update",
    query: "Ada",
    add: { phoneNumbers: ["4155550100"] },
    remove: { phoneNumbers: ["+14155550199"] },
  });
  expect(
    withDialNumber({ type: "phone_keypad", number: "415-555-0100" }),
  ).toEqual({
    type: "phone_keypad",
    number: "4155550100",
  });
  expect(withDialNumber({ type: "phone_keypad" })).toEqual({
    type: "phone_keypad",
  });
  expect(
    withDialNumber({
      type: "phone_call",
      target: { kind: "number", number: "415 555 0100" },
    }),
  ).toEqual({
    type: "phone_call",
    target: { kind: "number", number: "4155550100" },
  });
  // Text that is not one number is left for validation to refuse.
  const refused = withDialNumber({
    type: "contact_create",
    contact: {
      displayName: "A",
      phoneNumbers: ["call me"],
      emailAddresses: [],
    },
  }) as { contact: { phoneNumbers: string[] } };
  expect(refused.contact.phoneNumbers).toEqual(["call me"]);
  const created = validateDevicePayload({
    action: "device_action",
    version: 1,
    installationId: "device",
    enrollmentId: "enrollment",
    operation: withDialNumber({
      type: "contact_create",
      contact: {
        displayName: "Alpha Device Test",
        phoneNumbers: ["415-555-0100"],
        emailAddresses: [],
      },
    }),
  }).operation;
  expect(created).toMatchObject({ contact: { phoneNumbers: ["4155550100"] } });
});
