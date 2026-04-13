export const OWNER_NAME_MAX_LENGTH = 60;

export function normalizeOwnerName(value: string | null | undefined): string {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().slice(0, OWNER_NAME_MAX_LENGTH);
}
