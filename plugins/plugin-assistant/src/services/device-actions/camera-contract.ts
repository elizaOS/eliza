/** One foreground still capture. Pixels and paths never enter the agent receipt. */
export const CAMERA_CAPTURE_CAPABILITY = "camera.capture-photo.v1";
export type CameraCaptureOperation = { type: "camera_capture_photo" };
export type CameraCaptureResult = {
  version: 1;
  kind: "camera_capture_photo";
  operationId: string;
  mediaId: string;
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
  if (
    !isCameraCapture(value) ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1
  )
    throw new Error("Invalid camera capture operation");
  return { type: "camera_capture_photo" };
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
    width: row.width as number,
    height: row.height as number,
    mime: "image/jpeg",
  };
}
