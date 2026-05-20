import type { JsonValue } from "@elizaos/plugin-remote-manifest";

export type DynamicViewErrorCode =
  | "DYNAMIC_VIEW_DUPLICATE"
  | "DYNAMIC_VIEW_INVALID_MANIFEST"
  | "DYNAMIC_VIEW_NOT_FOUND"
  | "DYNAMIC_VIEW_SESSION_NOT_FOUND"
  | "DYNAMIC_VIEW_ENTRYPOINT_UNAVAILABLE"
  | "DYNAMIC_VIEW_UNSUPPORTED_ENTRYPOINT"
  | "DYNAMIC_VIEW_UNSUPPORTED_PLACEMENT"
  | "DYNAMIC_VIEW_REQUIRED_SATELLITE_UNAVAILABLE"
  | "DYNAMIC_VIEW_OPEN_FAILED"
  | "DYNAMIC_VIEW_PUSH_FAILED";

export class DynamicViewError extends Error {
  readonly code: DynamicViewErrorCode;
  readonly details?: JsonValue;

  constructor(
    code: DynamicViewErrorCode,
    message: string,
    details?: JsonValue,
  ) {
    super(message);
    this.name = "DynamicViewError";
    this.code = code;
    this.details = details;
  }
}
