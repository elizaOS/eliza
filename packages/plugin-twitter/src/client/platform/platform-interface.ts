export interface PlatformExtensions {
  /**
   * Randomizes the runtime's TLS ciphers to bypass TLS client fingerprinting, which
   * hopefully avoids random 404s on some requests.
   *
   * **References:**
   * - https://github.com/imputnet/cobalt/pull/574
   */
  randomizeCiphers(): Promise<void>;
}

export const genericPlatform = new (class implements PlatformExtensions {
  randomizeCiphers(): Promise<void> {
    return Promise.resolve();
  }
})();
