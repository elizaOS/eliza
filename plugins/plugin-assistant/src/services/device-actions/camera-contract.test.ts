import { describe, expect, it } from "vitest";
import { validateCameraCaptureResult } from "./camera-contract";

const receipt = {
  version: 1,
  kind: "camera_capture_photo",
  operationId: "op-1",
  mediaId: "42",
  width: 4000,
  height: 3000,
  mime: "image/jpeg",
};

describe("camera capture receipt", () => {
  it("keeps an optional photo library id", () => {
    expect(validateCameraCaptureResult(receipt, "op-1")).toEqual(receipt);
    expect(
      validateCameraCaptureResult(
        { ...receipt, libraryId: "lib:i:42:1700000000000" },
        "op-1",
      ).libraryId,
    ).toBe("lib:i:42:1700000000000");
  });

  it("refuses a library id that is not a photo", () => {
    for (const libraryId of ["42", "lib:v:42:1", "", 42])
      expect(() =>
        validateCameraCaptureResult({ ...receipt, libraryId }, "op-1"),
      ).toThrow("Invalid saved photo receipt");
  });
});
