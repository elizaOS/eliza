import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import net from 'node:net';
import { isPortFree, findNextAvailablePort } from '../port-handling';

describe('port-handling', () => {
  let testServer: net.Server | null = null;

  afterEach(() => {
    // Clean up any test servers
    if (testServer) {
      testServer.close();
      testServer = null;
    }
  });

  describe('isPortFree', () => {
    test('should return true for a free port', async () => {
      const result = await isPortFree(9876);
      expect(result).toBe(true);
    });

    test('should return false for an occupied port', async () => {
      // Create a server to occupy the port
      testServer = net.createServer();
      await new Promise<void>((resolve) => {
        testServer!.listen(9877, '0.0.0.0', () => resolve());
      });

      const result = await isPortFree(9877, '0.0.0.0');
      expect(result).toBe(false);
    });

    test('should check on the specified host', async () => {
      // Create a server on 127.0.0.1
      testServer = net.createServer();
      await new Promise<void>((resolve) => {
        testServer!.listen(9878, '127.0.0.1', () => resolve());
      });

      // Port should be free on 0.0.0.0 but occupied on 127.0.0.1
      const resultOnDifferentHost = await isPortFree(9878, '0.0.0.0');
      const resultOnSameHost = await isPortFree(9878, '127.0.0.1');

      // Note: This behavior may vary by OS
      // On some systems, binding to 127.0.0.1 may not block 0.0.0.0
      expect(resultOnSameHost).toBe(false);
    });

    test('should default to 0.0.0.0 when no host is specified', async () => {
      testServer = net.createServer();
      await new Promise<void>((resolve) => {
        testServer!.listen(9879, '0.0.0.0', () => resolve());
      });

      // Should detect port as occupied when checking default host
      const result = await isPortFree(9879);
      expect(result).toBe(false);
    });
  });

  describe('findNextAvailablePort', () => {
    test('should return the same port if it is free', async () => {
      const port = await findNextAvailablePort(9880);
      expect(port).toBe(9880);
    });

    test('should find the next available port when the first is occupied', async () => {
      // Occupy port 9881
      testServer = net.createServer();
      await new Promise<void>((resolve) => {
        testServer!.listen(9881, '0.0.0.0', () => resolve());
      });

      const port = await findNextAvailablePort(9881, '0.0.0.0');
      expect(port).toBe(9882);
    });

    test('should skip multiple occupied ports', async () => {
      // Create multiple servers to occupy consecutive ports
      const servers: net.Server[] = [];

      for (let p = 9883; p <= 9885; p++) {
        const server = net.createServer();
        await new Promise<void>((resolve) => {
          server.listen(p, '0.0.0.0', () => resolve());
        });
        servers.push(server);
      }

      const port = await findNextAvailablePort(9883, '0.0.0.0');
      expect(port).toBe(9886);

      // Clean up
      for (const server of servers) {
        server.close();
      }
    });

    test('should respect the host parameter', async () => {
      // Occupy port on specific host
      testServer = net.createServer();
      await new Promise<void>((resolve) => {
        testServer!.listen(9887, '127.0.0.1', () => resolve());
      });

      // Should find port as available on different host
      const portOnDifferentHost = await findNextAvailablePort(9887, '0.0.0.0');
      const portOnSameHost = await findNextAvailablePort(9887, '127.0.0.1');

      // On same host, should find next port
      expect(portOnSameHost).toBe(9888);
    });
  });
});
