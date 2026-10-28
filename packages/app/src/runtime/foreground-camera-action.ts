import type { Action, ActionParameterSchema } from "@elizaos/core";
import { proposeDeviceAction } from "@elizaos/plugin-assistant";

const operation = proposeDeviceAction.parameters?.find(
  (value) => value.name === "operation",
);
const branches =
  operation?.schema && "anyOf" in operation.schema
    ? operation.schema.anyOf
    : undefined;
const camera = Array.isArray(branches)
  ? branches.filter(
      (branch) =>
        branch &&
        typeof branch === "object" &&
        "properties" in branch &&
        (branch.properties as Record<string, { enum?: readonly string[] }>).type
          ?.enum?.length === 1 &&
        (branch.properties as Record<string, { enum?: readonly string[] }>).type
          ?.enum?.[0] === "camera_capture_photo",
    )
  : [];
if (camera.length !== 1) throw Error("Canonical Camera operation unavailable");
/** Foreground explicit capture only; no camera stream or pixel data enters model context. */
export const foregroundCameraAction: Action = Object.freeze({
  ...proposeDeviceAction,
  name: "DEVICE_CAMERA_CAPTURE",
  similes: [],
  contexts: ["media", "general"],
  description:
    "Ask the current enrolled device to take one photo using its visible Camera. The owner reviews the capture on the device; wait for its saved-photo receipt before claiming success. Pixels and paths stay on the device.",
  parameters: proposeDeviceAction.parameters?.map((parameter) =>
    parameter.name === "operation"
      ? { ...parameter, schema: { anyOf: camera } as ActionParameterSchema }
      : parameter,
  ),
  async handler(...args: Parameters<NonNullable<Action["handler"]>>) {
    const raw = args[3]?.parameters;
    const op =
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, unknown>).operation
        : undefined;
    if (
      !op ||
      typeof op !== "object" ||
      Array.isArray(op) ||
      Reflect.get(op, "type") !== "camera_capture_photo"
    )
      return {
        success: false,
        text: "This action only requests a reviewed photo capture.",
        data: { code: "DEVICE_OPERATION_SCOPE" },
      };
    return proposeDeviceAction.handler!(...args);
  },
});
