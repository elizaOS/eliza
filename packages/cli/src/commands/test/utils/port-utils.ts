import * as net from 'node:net';

/**
 * Helper function to check port availability
 */
export async function checkPortAvailable(port: number): Promise<boolean> {
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
 * Get an available port starting from the preferred port
 */
export async function getAvailablePort(preferredPort: number): Promise<number> {
  let port = preferredPort;
  const maxAttempts = 10;

  for (let i = 0; i < maxAttempts; i++) {
    if (await checkPortAvailable(port)) {
      return port;
    }
    port++;
  }

  throw new Error(
    `Could not find an available port after ${maxAttempts} attempts starting from ${preferredPort}`
  );
}
