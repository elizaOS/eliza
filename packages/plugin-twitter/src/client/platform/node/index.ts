import type { PlatformExtensions } from '../platform-interface';
import { randomizeCiphers } from './randomize-ciphers';

class NodePlatform implements PlatformExtensions {
  randomizeCiphers(): Promise<void> {
    randomizeCiphers();
    return Promise.resolve();
  }
}

export const platform = new NodePlatform();
