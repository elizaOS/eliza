import { type Plugin } from '@elizaos/core';
import { DummyTokenDataService } from './tokenData/service';
import { DummyLpService } from './lp/service';
import { DummyWalletService } from './wallet/service';
import { DummyPdfService } from './pdf/service';
import { DummyVideoService } from './video/service';
import { DummyBrowserService } from './browser/service';
import { DummyTranscriptionService } from './transcription/service';
import { DummyWebSearchService } from './web-search/service';
import { DummyEmailService } from './email/service';
import { dummyServicesScenariosSuite } from './e2e/scenarios';

export const dummyServicesPlugin: Plugin = {
  name: 'dummy-services',
  description: 'Load standard dummy services for testing purposes.',
  services: [
    DummyTokenDataService,
    DummyLpService,
    DummyWalletService,
    DummyPdfService,
    DummyVideoService,
    DummyBrowserService,
    DummyTranscriptionService,
    DummyWebSearchService,
    DummyEmailService,
  ],
  tests: [dummyServicesScenariosSuite],
  init: async (runtime) => {
    console.log('Dummy Services Plugin Initialized');
  },
};

export default dummyServicesPlugin;

// Export services for direct use
export {
  DummyTokenDataService,
  DummyLpService,
  DummyWalletService,
  DummyPdfService,
  DummyVideoService,
  DummyBrowserService,
  DummyTranscriptionService,
  DummyWebSearchService,
  DummyEmailService,
};
