import { type Provider } from '@elizaos/core';
import { trainingStatusProvider } from './training-status-provider.js';

/**
 * All training plugin providers
 */
export const trainingProviders: Provider[] = [trainingStatusProvider];

export { trainingStatusProvider };
