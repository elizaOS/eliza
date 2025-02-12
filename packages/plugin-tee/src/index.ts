import type { Plugin } from '@elizaos/core';
import { deriveKeyProvider } from './providers/deriveKeyProvider';
import { remoteAttestationProvider } from './providers/remoteAttestationProvider';

export { DeriveKeyProvider } from './providers/deriveKeyProvider';

import { sgxAttestationProvider } from './providers/sgxAttestationProvider';
import { TeeLogService } from './services/teeLogService';

export { TeeLogService };

export const teePlugin: Plugin = {
    name: 'tee',
    description: 'TEE plugin with actions to generate remote attestations and derive keys',
    actions: [],
    evaluators: [],
    providers: [remoteAttestationProvider, deriveKeyProvider, sgxAttestationProvider],
    services: [new TeeLogService()],
};
