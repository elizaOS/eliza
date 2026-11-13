/**
 * Holds remote runtime bearer tokens in memory for the current tab. They are
 * never written to browser storage.
 */

const sessionCredentials = new Map<string, string>();

function requireRuntimeId(runtimeId: string): string {
  const value = runtimeId.trim();
  if (!/^[A-Za-z0-9._:-]{1,256}$/.test(value)) {
    throw new Error("Runtime id is invalid.");
  }
  return value;
}

export async function storeRuntimeCredential(
  runtimeIdValue: string,
  accessTokenValue: string,
): Promise<"secure" | "session"> {
  const runtimeId = requireRuntimeId(runtimeIdValue);
  const accessToken = accessTokenValue.trim();
  if (!accessToken) throw new Error("Runtime access token cannot be empty.");
  sessionCredentials.set(runtimeId, accessToken);
  return "session";
}

export async function deleteRuntimeCredentialRecord(
  runtimeIdValue: string,
): Promise<boolean> {
  const runtimeId = requireRuntimeId(runtimeIdValue);
  return sessionCredentials.delete(runtimeId);
}
