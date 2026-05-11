import type { Plugin } from "@elizaos/core";

import { deviceListDirAction } from "./actions/list-dir.js";
import { deviceFileReadAction } from "./actions/read.js";
import { deviceFileWriteAction } from "./actions/write.js";
import { DeviceFilesystemBridge } from "./services/device-filesystem-bridge.js";

export const deviceFilesystemPlugin: Plugin = {
  name: "device-filesystem",
  description:
    "Mobile-safe filesystem actions (DEVICE_FILE_READ, DEVICE_FILE_WRITE, DEVICE_LIST_DIR) that route through @capacitor/filesystem on iOS/Android and a Node fs/promises workspace under resolveStateDir() on desktop/AOSP.",
  services: [DeviceFilesystemBridge],
  actions: [deviceFileReadAction, deviceFileWriteAction, deviceListDirAction],
};

export default deviceFilesystemPlugin;

export { deviceFileReadAction } from "./actions/read.js";
export { deviceFileWriteAction } from "./actions/write.js";
export { deviceListDirAction } from "./actions/list-dir.js";
export {
  DeviceFilesystemBridge,
  getDeviceFilesystemBridge,
} from "./services/device-filesystem-bridge.js";
export {
  DEVICE_FILESYSTEM_LOG_PREFIX,
  DEVICE_FILESYSTEM_SERVICE_TYPE,
  type DirectoryEntry,
  type FileEncoding,
} from "./types.js";
export { normalizeDevicePath } from "./path.js";
