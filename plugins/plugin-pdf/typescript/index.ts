import type { Plugin } from "@elizaos/core";
import { PdfService } from "./services/pdf";

export * from "./services";
export * from "./types";

export const pdfPlugin: Plugin = {
  name: "pdf",
  description: "Plugin for PDF reading and text extraction",
  services: [PdfService],
  actions: [],
};

export default pdfPlugin;
