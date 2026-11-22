import { isLibraryId, libraryKindOf } from "./photo-library-contract.ts";

/** One foreground still capture. Pixels and paths never enter the agent receipt. */
export const CAMERA_CAPTURE_CAPABILITY = "camera.capture-photo.v1";
/** `camera_capture_photo` with a requested `lens`. */
export const CAMERA_LENS_CAPABILITY = "camera.capture-lens.v1";
/** A saved-photo receipt that also names the photo's library id, so the agent can open or share
 * the photo it just took with the Photos operations. */
export const CAMERA_LIBRARY_ID_CAPABILITY = "camera.capture-library-id.v1";
/** The single-operation tool for `camera_capture_photo` (tools.ts). */
export const DEVICE_CAMERA_CAPTURE_ACTION = "DEVICE_CAMERA_CAPTURE";
/** Without `lens` the phone uses the camera that is showing. */
export type CameraCaptureOperation = {
  type: "camera_capture_photo";
  lens?: "front" | "back";
};
export type CameraCaptureResult = {
  version: 1;
  kind: "camera_capture_photo";
  operationId: string;
  mediaId: string;
  /** The saved photo's library id. Sent only with `camera.capture-library-id.v1`. */
  libraryId?: string;
  width: number;
  height: number;
  mime: "image/jpeg";
};
export function isCameraCapture(
  value: unknown,
): value is CameraCaptureOperation {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { type?: unknown }).type === "camera_capture_photo"
  );
}
export function validateCameraCapture(value: unknown): CameraCaptureOperation {
  if (!isCameraCapture(value) || Array.isArray(value))
    throw new Error("Invalid camera capture operation");
  const lens = (value as { lens?: unknown }).lens;
  if (
    Object.keys(value).length !== (lens === undefined ? 1 : 2) ||
    (lens !== undefined && lens !== "front" && lens !== "back")
  )
    throw new Error("Invalid camera capture operation");
  return { type: "camera_capture_photo", ...(lens ? { lens } : {}) };
}
/** A requested lens is never sent to a phone that did not negotiate `camera.capture-lens.v1`. */
export function cameraCaptureCapabilityAvailable(
  operation: CameraCaptureOperation,
  capabilities: readonly string[] | undefined,
): boolean {
  return (
    capabilities?.includes(CAMERA_CAPTURE_CAPABILITY) === true &&
    (operation.lens === undefined ||
      capabilities.includes(CAMERA_LENS_CAPABILITY))
  );
}
export function validateCameraCaptureResult(
  value: unknown,
  operationId?: string,
): CameraCaptureResult {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Missing saved photo receipt");
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).some(
      (key) =>
        ![
          "version",
          "kind",
          "operationId",
          "mediaId",
          "libraryId",
          "width",
          "height",
          "mime",
        ].includes(key),
    ) ||
    row.version !== 1 ||
    row.kind !== "camera_capture_photo" ||
    row.mime !== "image/jpeg" ||
    typeof row.operationId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(row.operationId) ||
    (operationId !== undefined && row.operationId !== operationId) ||
    typeof row.mediaId !== "string" ||
    !/^[1-9][0-9]{0,24}$/.test(row.mediaId) ||
    (row.libraryId !== undefined &&
      !(
        isLibraryId(row.libraryId) && libraryKindOf(row.libraryId) === "image"
      )) ||
    ![row.width, row.height].every(
      (n) =>
        typeof n === "number" && Number.isSafeInteger(n) && n > 0 && n <= 65536,
    )
  )
    throw new Error("Invalid saved photo receipt");
  return {
    version: 1,
    kind: "camera_capture_photo",
    operationId: row.operationId,
    mediaId: row.mediaId,
    ...(row.libraryId === undefined
      ? {}
      : { libraryId: row.libraryId as string }),
    width: row.width as number,
    height: row.height as number,
    mime: "image/jpeg",
  };
}
