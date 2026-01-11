/**
 * @elizaos/plugin-pdf
 *
 * PDF Plugin for elizaOS.
 * Provides PDF reading and text extraction functionality.
 */

import type { Plugin } from "@elizaos/core";
import { PdfService } from "./services/pdf";

export * from "./services";
export * from "./types";

/**
 * PDF Plugin for elizaOS.
 */
export const pdfPlugin: Plugin = {
  name: "pdf",
  description: "Plugin for PDF reading and text extraction",
  services: [PdfService],
  actions: [],
};

export default pdfPlugin;
