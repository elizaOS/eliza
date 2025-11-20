/**
 * Networking helpers for tests
 *
 * Provides utilities for port discovery and network operations in tests.
 */

import * as net from 'node:net';

/**
 * Check if a port is available for use
 *
 * @param port - Port number to check
 * @returns Promise<boolean> - true if port is available
 */
export async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once('error', () => {
      resolve(false);
    });

    server.once('listening', () => {
      server.close();
      resolve(true);
    });

    server.listen(port);
  });
}

/**
 * Find an available port in the specified range
 *
 * @param range - [min, max] port range
 * @returns Promise<number> - Available port number
 * @throws Error if no port is available in range
 *
 * @example
 * ```typescript
 * const port = await findAvailablePort([5000, 6000]);
 * console.log(`Server will use port ${port}`);
 * ```
 */
export async function findAvailablePort(range: [number, number]): Promise<number> {
  const [min, max] = range;

  // Try ports in random order to reduce collisions in parallel tests
  const ports = Array.from({ length: max - min + 1 }, (_, i) => min + i);
  shuffleArray(ports);

  for (const port of ports) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }

  throw new Error(`No available ports found in range [${min}, ${max}]`);
}

/**
 * Fisher-Yates shuffle algorithm
 * @param array - Array to shuffle in-place
 */
function shuffleArray<T>(array: T[]): void {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}
