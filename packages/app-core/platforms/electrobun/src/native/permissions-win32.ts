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
      // Windows desktop privacy state is not reliably observable here.
      // Report requestable until runtime capture actually proves access.
      return { status: "not-determined", canRequest: true };

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
  if (id === "microphone" || id === "camera") {
    await openPrivacySettings(id);
  }
  return checkPermission(id);
}

export async function openPrivacySettings(
  id: SystemPermissionId,
): Promise<void> {
  const settingsMap: Record<string, string> = {
    microphone: "ms-settings:privacy-microphone",
    camera: "ms-settings:privacy-webcam",
  };

  const uri = settingsMap[id];
  if (uri) {
    try {
      Bun.spawn(["cmd", "/c", "start", uri], {
        stdout: "ignore",
        stderr: "ignore",
      });
    } catch {
      // Settings unavailable
    }
  }
}
