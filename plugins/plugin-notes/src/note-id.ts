/** Stable legacy canonical IDs or RFC-shaped UUIDs used by installed app records. No re-keying. */
export const NOTE_ID_PATTERN =
  "^(?:[a-z][a-z0-9-]{2,127}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$";
export const NOTE_ID_REGEXP = new RegExp(NOTE_ID_PATTERN);

/** Operation IDs are shared with the device recording store and must match exactly. */
export const RECORDING_DELETION_ID_REGEXP =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
