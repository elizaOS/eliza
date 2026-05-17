/**
 * Browser stub. omnivoice.cpp is a native FFI binding — there is no
 * browser path. We export an inert plugin so dual-target bundles do not
 * fail to import.
 */

import type { Plugin } from "@elizaos/core";
import { OmnivoiceNotInstalled } from "./errors";

export const omnivoicePlugin: Plugin = {
  name: "omnivoice",
  description:
    "omnivoice TTS is unavailable in the browser. Use a Node/Bun runtime.",
  models: {
    TEXT_TO_SPEECH: async () => {
      throw new OmnivoiceNotInstalled("browser runtime — no native FFI");
    },
  },
};

export default omnivoicePlugin;

export { OmnivoiceNotInstalled } from "./errors";
export type { Emotion } from "./types";
