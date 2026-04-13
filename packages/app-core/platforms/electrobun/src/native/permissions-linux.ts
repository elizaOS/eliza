import type {
  PermissionCheckResult,
  SystemPermissionId,
} from "./permissions-shared";

export async function checkPermission(
  id: SystemPermissionId,
): Promise<PermissionCheckResult> {
  switch (id) {
    case "microphone":
    case "camera":
    case "shell":
      return { status: "granted", canRequest: false };

    case "accessibility":
    case "screen-recording":
      return { status: "not-applicable", canRequest: false };

    default:
      return { status: "not-applicable", canRequest: false };
  }
}

export async function requestPermission(
  id: SystemPermissionId,
): Promise<PermissionCheckResult> {
  return checkPermission(id);
}

export async function openPrivacySettings(
  _id: SystemPermissionId,
): Promise<void> {
  // No unified privacy settings on Linux
}
