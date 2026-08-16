/**
 * Applies host-native filesystem path validation to the browser-safe wire
 * contract before the app registry receives a directory.
 */

import nodePath from "node:path";
import { PostLoadFromDirectoryRequestSchema } from "@elizaos/shared";

export const PostLoadFromDirectoryServerRequestSchema =
  PostLoadFromDirectoryRequestSchema.refine(
    ({ directory }) => nodePath.isAbsolute(directory),
    {
      message: "directory must be an absolute path on this host",
      path: ["directory"],
    },
  );
