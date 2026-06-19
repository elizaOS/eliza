import type { Plugin } from "@elizaos/core";
import { PdfService } from "./services/pdf";

export { PdfService } from "./services/pdf";
export * from "./types";

export const pdfPlugin: Plugin = {
  name: "pdf",
  description: "Plugin for PDF reading and text extraction",
  services: [PdfService],
  actions: [],
  async dispose(runtime) {
    const svc = runtime.getService<PdfService>(PdfService.serviceType);
    await svc?.stop();
  },
};

const defaultPdfPlugin = pdfPlugin;

export default defaultPdfPlugin;
