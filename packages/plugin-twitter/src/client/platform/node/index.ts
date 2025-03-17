import type { PlatformExtensions } from '../platform-interface';
import { randomizeCiphers } from './randomize-ciphers';

/**
 * Asynchronously randomizes the order of ciphers used by the Node.js platform.
 * @returns {Promise<void>} A Promise that resolves once the ciphers have been randomized.
 */
class NodePlatform implements PlatformExtensions {
  /**
   * Asynchronously randomizes ciphers.
   *
   * @returns {Promise<void>} A promise that resolves once the ciphers are randomized.
   */
  randomizeCiphers(): Promise<void> {
    randomizeCiphers();
    return Promise.resolve();
  }
}

export const platform = new NodePlatform();
