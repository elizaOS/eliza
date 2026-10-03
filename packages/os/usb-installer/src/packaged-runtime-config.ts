// Resolves durable per-user state for the packaged installer's rollback guard.
import { homedir } from "node:os";
import path from "node:path";
import { RELEASE_SEQUENCE_STATE_PATH_ENV } from "./backend/release-sequence-store";

export function configurePackagedReleaseSequenceState(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  userHome: string = homedir(),
): string {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const configured = env[RELEASE_SEQUENCE_STATE_PATH_ENV];
  if (configured) {
    if (!pathApi.isAbsolute(configured)) {
      throw new Error("Packaged release sequence state path must be absolute.");
    }
    return configured;
  }

  let stateRoot: string;
  if (platform === "darwin") {
    stateRoot = pathApi.join(userHome, "Library", "Application Support");
  } else if (platform === "win32") {
    stateRoot = env.LOCALAPPDATA || pathApi.join(userHome, "AppData", "Local");
  } else {
    stateRoot = env.XDG_STATE_HOME || pathApi.join(userHome, ".local", "state");
  }

  if (!pathApi.isAbsolute(stateRoot)) {
    throw new Error("Packaged release sequence state root must be absolute.");
  }
  const statePath = pathApi.join(
    stateRoot,
    "elizaOS",
    "usb-installer",
    "release-sequence.json",
  );
  env[RELEASE_SEQUENCE_STATE_PATH_ENV] = statePath;
  return statePath;
}
