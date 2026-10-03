import { createRequire } from "node:module";

/** The packaged native module is trusted code, never a path from installer IPC. */
export function loadLinuxInstallerNativeBinding(): unknown {
  try {
    return createRequire(import.meta.url)(
      "../native/build/linux-peer-credentials.node",
    );
  } catch (error) {
    throw new Error(
      "Installer native Linux module is unavailable; refusing to start.",
      { cause: error },
    );
  }
}
