/** Reversible local actions a phone may run without its review card when the
 * owner turned review off and the proposal is bound to the current message.
 * Sends, deletes, private reads and Calendar/reminder writes are never listed. */
export const DIRECT_REQUEST_OPERATION_TYPES = [
  "create_note",
  "open_view",
  "browser_navigate",
  "camera_capture_photo",
  "photo_library_select",
] as const;

export type DirectRequestOperationType =
  (typeof DIRECT_REQUEST_OPERATION_TYPES)[number];

export function isDirectRequestOperationType(
  type: string,
): type is DirectRequestOperationType {
  return (DIRECT_REQUEST_OPERATION_TYPES as readonly string[]).includes(type);
}
