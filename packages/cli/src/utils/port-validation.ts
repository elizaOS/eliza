/**
 * Validates a port number and returns it as an integer.
 * Throws an error if the port is invalid.
 */
export function validatePort(value: string): number {
  const port = Number.parseInt(value, 10);
  if (Number.isNaN(port) || port <= 0 || port > 65535) {
    throw new Error('Port must be a number between 1 and 65535');
  }
  return port;
}
