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
} from "../src/services/device-actions/action";
import { validateDevicePayload } from "../src/services/device-actions/contract";

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
    "sms.compose.v1": ["sms_compose", "sms_reply_selected"],
    "messages.read.v1": ["messages_read_selected"],
    "voicemail.read.v1": ["voicemail_read_selected"],
    "voicemail.delete.v1": ["voicemail_delete_selected"],
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
  ])
    expect(text).toContain(required);
  for (const operation of [
    { type: "phone_call", target: { kind: "contact", query: "Ada" } },
    { type: "contact_delete", query: "Ada" },
    { type: "sms_compose", query: "Ada", body: "Late." },
    { type: "sms_reply_selected", body: "Late." },
    { type: "messages_read_selected" },
    { type: "voicemail_read_selected" },
    { type: "voicemail_delete_selected" },
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
