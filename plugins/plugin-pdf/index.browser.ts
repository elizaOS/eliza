import { pdfPlugin } from "./index";

export { PdfService } from "./services/pdf";
export * from "./types";
export { pdfPlugin };

const defaultPdfPlugin = pdfPlugin;

export default defaultPdfPlugin;
