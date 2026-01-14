import type { Plugin } from "@elizaos/core";
import {
  changeDirectory,
  editFile,
  executeShell,
  git,
  listFiles,
  readFile,
  searchFiles,
  writeFile,
} from "./actions";
import { coderStatusProvider } from "./providers";
import { CoderService } from "./services/coderService";

export const coderPlugin: Plugin = {
  name: "eliza-coder",
  description: "Coder tools: filesystem, shell, and git (restricted)",
  services: [CoderService],
  actions: [
    readFile,
    listFiles,
    searchFiles,
    writeFile,
    editFile,
    changeDirectory,
    executeShell,
    git,
  ],
  providers: [coderStatusProvider],
};

export default coderPlugin;

export * from "./actions";
export { coderStatusProvider } from "./providers/coderStatusProvider";
export { CoderService } from "./services/coderService";
export * from "./types";
export * from "./utils";
