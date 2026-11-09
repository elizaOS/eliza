import type { Action } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

vi.mock("./service.ts", () => ({
  getDeviceActionTurn: () => undefined,
  deviceAppRecordOperationAvailable: () => true,
  DeviceActionService: class {},
}));

import {
  deviceActionForCapabilities,
  PHOTO_LIBRARY_GUIDANCE,
  proposeDeviceAction,
} from "./action";
import {
  DeviceActionError,
  deviceOperationSupportedByCapabilities,
  validateDeviceOperation,
  validateDevicePayload,
} from "./contract";
import { PHOTO_LIBRARY_CAPABILITY } from "./photo-library-contract";

const LIBRARY_TYPES = [
  "photo_library_search",
  "photo_library_inspect",
  "photo_library_select",
];
const types = (action: Action): string[] =>
  (
    action.parameters?.find((p) => p.name === "operation")?.schema.anyOf ?? []
  ).flatMap((b) => (b.properties?.type?.enum ?? []).map(String));
const image = "lib:i:42:1700000000000";
const video = "lib:v:43:1700000000001";

describe("photo library proposals", () => {
  it("offers search, inspect and select only when photos.library.v1 was negotiated", () => {
    const offered = deviceActionForCapabilities(proposeDeviceAction, [
      "notes.local-record.v1",
      PHOTO_LIBRARY_CAPABILITY,
    ]);
    expect(types(offered)).toEqual(expect.arrayContaining(LIBRARY_TYPES));
    expect(types(offered)).not.toContain("photo_library_review");
    expect(offered.description).toContain(PHOTO_LIBRARY_GUIDANCE);

    for (const capabilities of [["notes.local-record.v1"], undefined]) {
      const absent = deviceActionForCapabilities(
        proposeDeviceAction,
        capabilities,
      );
      for (const type of LIBRARY_TYPES)
        expect(types(absent)).not.toContain(type);
      expect(absent.description).not.toContain(PHOTO_LIBRARY_GUIDANCE);
      expect(absent.description).toContain("notes_search");
    }
  });

  it("gates server support on the negotiated capability", () => {
    for (const type of LIBRARY_TYPES) {
      expect(
        deviceOperationSupportedByCapabilities(type, [
          PHOTO_LIBRARY_CAPABILITY,
        ]),
      ).toBe(true);
      expect(
        deviceOperationSupportedByCapabilities(type, ["notes.local-record.v1"]),
      ).toBe(false);
      expect(deviceOperationSupportedByCapabilities(type, undefined)).toBe(
        false,
      );
    }
  });

  it("validates each operation with the library contract", () => {
    expect(
      validateDeviceOperation({
        type: "photo_library_search",
        kind: "video",
        from: 1,
        to: 2,
        favorites: true,
        limit: 24,
      }),
    ).toEqual({
      type: "photo_library_search",
      kind: "video",
      from: 1,
      to: 2,
      favorites: true,
      limit: 24,
    });
    expect(validateDeviceOperation({ type: "photo_library_search" })).toEqual({
      type: "photo_library_search",
    });
    expect(
      validateDeviceOperation({ type: "photo_library_inspect", id: image }),
    ).toEqual({ type: "photo_library_inspect", id: image });
    expect(
      validateDeviceOperation({
        type: "photo_library_select",
        ids: [image, video],
      }),
    ).toEqual({ type: "photo_library_select", ids: [image, video] });
    expect(
      validateDevicePayload({
        action: "device_action",
        version: 1,
        installationId: "phone-1",
        enrollmentId: "enroll-1",
        operation: { type: "photo_library_inspect", id: image },
      }).operation,
    ).toEqual({ type: "photo_library_inspect", id: image });
  });

  it.each([
    { type: "photo_library_search", limit: 25 },
    { type: "photo_library_search", query: "beach" },
    { type: "photo_library_search", from: 5, to: 1 },
    { type: "photo_library_inspect", id: "content://media/1" },
    { type: "photo_library_select", ids: [] },
    { type: "photo_library_select", ids: [image, image] },
    {
      type: "photo_library_select",
      ids: Array.from({ length: 21 }, (_, i) => `lib:i:${i + 1}:0`),
    },
    {
      type: "photo_library_review",
      action: "trash",
      items: [{ id: image, revision: "rev-a-1" }],
    },
  ])("rejects %j", (operation) => {
    expect(() => validateDeviceOperation(operation)).toThrow(DeviceActionError);
  });
});
