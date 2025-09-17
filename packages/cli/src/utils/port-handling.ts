import net from 'node:net';

/**
 * Checks if a given port is free.
 * @param port The port number to check.
 * @param host The host to check on (defaults to 0.0.0.0 to match server behavior)
 * @returns Promise<boolean> indicating if the port is free.
 */
export function isPortFree(port: number, host: string = '0.0.0.0'): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });

    // Listen on the same host that the ElizaOS server will use
    server.listen(port, host);
  });
}

/**
 * Finds the next available port starting from the given port.
 * @param startPort The initial port to check.
 * @param host The host to check on (defaults to 0.0.0.0)
 * @returns Promise<number> The next available port.
 */
export async function findNextAvailablePort(startPort: number, host?: string): Promise<number> {
  let port = startPort;
  while (!(await isPortFree(port, host))) {
    port++;
  }
  return port;
}
