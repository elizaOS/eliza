import net from 'node:net';

/**
 * Checks if a given port is free.
 * @param port The port number to check.
 * @returns Promise<boolean> indicating if the port is free.
 */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close();
      resolve(true);
    });

    server.listen(port);
  });
}

/**
 * Finds the next available port starting from the given port.
 * @param startPort The initial port to check.
 * @returns Promise<number> The next available port.
 */
export async function findNextAvailablePort(startPort: number): Promise<number> {
  let port = startPort;
  while (!(await isPortFree(port))) {
    port++;
  }
  return port;
}
