/** Registers the design service; action/view wiring lands with the domain UI issues. */

import type { Plugin } from "@elizaos/core";
import { DesignService } from "./service.js";

export const designPlugin: Plugin = {
  name: "design",
  description:
    "Provider-neutral design search, lookup, export, and comment reads with local-mode Canva and Figma adapters.",
  services: [DesignService],
};

export default designPlugin;
