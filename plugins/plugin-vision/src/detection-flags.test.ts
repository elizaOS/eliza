/**
 * Pins how VisionService reads its detection toggles from runtime settings.
 * `getSetting` returns character settings untouched, so a boolean stored in
 * character JSON must count the same as the string spelling an env file
 * holds; the face-recognition flag already does, and object/pose detection
 * must not diverge from it. Real service construction, no mocks of the config
 * loader.
 */

import { describe, expect, it } from "vitest";
import { VisionService } from "./service";

type SettingValue = string | boolean | number | undefined;

function serviceWith(settings: Record<string, SettingValue>) {
  const runtime = {
    getSetting: (key: string) => settings[key],
    character: { name: "test", settings: {} },
    getService: () => null,
  } as unknown as ConstructorParameters<typeof VisionService>[0];
  return new VisionService(runtime) as unknown as {
    visionConfig: {
      enableObjectDetection: boolean;
      enablePoseDetection: boolean;
      enableFaceRecognition: boolean;
    };
  };
}

describe("VisionService detection flags", () => {
  it("defaults every detector off", () => {
    const { visionConfig } = serviceWith({});
    expect(visionConfig.enableObjectDetection).toBe(false);
    expect(visionConfig.enablePoseDetection).toBe(false);
    expect(visionConfig.enableFaceRecognition).toBe(false);
  });

  it.each([
    ["string true", "true"],
    ["boolean true", true],
  ])("ENABLE_OBJECT_DETECTION=%s enables object detection", (_label, value) => {
    expect(
      serviceWith({ ENABLE_OBJECT_DETECTION: value }).visionConfig
        .enableObjectDetection,
    ).toBe(true);
  });

  it.each([
    ["string true", "true"],
    ["boolean true", true],
  ])(
    "VISION_ENABLE_POSE_DETECTION=%s (the legacy alias) enables pose detection",
    (_label, value) => {
      expect(
        serviceWith({ VISION_ENABLE_POSE_DETECTION: value }).visionConfig
          .enablePoseDetection,
      ).toBe(true);
    },
  );

  it.each([
    ["string true", "true"],
    ["boolean true", true],
  ])(
    "ENABLE_FACE_RECOGNITION=%s enables face recognition (the existing contract)",
    (_label, value) => {
      expect(
        serviceWith({ ENABLE_FACE_RECOGNITION: value }).visionConfig
          .enableFaceRecognition,
      ).toBe(true);
    },
  );

  it.each([
    ["string false", "false"],
    ["boolean false", false],
  ])(
    "ENABLE_OBJECT_DETECTION=%s keeps object detection off",
    (_label, value) => {
      expect(
        serviceWith({ ENABLE_OBJECT_DETECTION: value }).visionConfig
          .enableObjectDetection,
      ).toBe(false);
    },
  );
});
