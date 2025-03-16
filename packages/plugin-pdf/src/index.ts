import type { Plugin } from '@elizaos/core';

import { PdfService } from './services/pdf';

export const pdfPlugin: Plugin = {
  name: 'pdf',
  description: 'Plugin for PDF reading and processing',
  services: [PdfService],
  actions: [],
};

export default pdfPlugin;
