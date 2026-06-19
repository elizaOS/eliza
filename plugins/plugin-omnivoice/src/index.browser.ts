/**
 * Browser unavailable entry. omnivoice.cpp is a native FFI binding, so
 * browser imports expose the package shape and fail clearly when TTS is
 * invoked.
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
