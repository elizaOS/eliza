import { type PlatformExtensions, genericPlatform } from './platform-interface.js';

export * from './platform-interface.js';

const PLATFORM_NODE: boolean = typeof process !== 'undefined';

/**
 * Class representing a platform with cipher randomization functionality.
 */
export class Platform implements PlatformExtensions {
  /**
   * Asynchronously generates random ciphers using the imported platform
   */
  async randomizeCiphers() {
    const platform = await Platform.importPlatform();
    await platform?.randomizeCiphers();
  }

  /**
   * Imports and returns the platform extensions based on the current platform.
   * @returns A Promise that resolves to the platform extensions, or null if the platform is not supported.
   */
  private static async importPlatform(): Promise<null | PlatformExtensions> {
    if (PLATFORM_NODE) {
      const { platform } = await import('./node/index.js');
      return platform as PlatformExtensions;
    }

    return genericPlatform;
  }
}
