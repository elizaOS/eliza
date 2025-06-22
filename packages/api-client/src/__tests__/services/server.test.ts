import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, mock, spyOn } from 'bun:test';
import { Server } from '../../services/server';
import type { ServerConfig, ServerMetrics, HealthCheck } from '../../types/server';

// Mock external dependencies
const mockFetch = mock(() => Promise.resolve({ status: 200, json: () => Promise.resolve({}) }));
const mockProcess = mock(() => ({ 
  memoryUsage: () => ({ rss: 1024, heapTotal: 512, heapUsed: 256, external: 0, arrayBuffers: 0 })
}));

describe('Server Initialization and Configuration', () => {
  let server: Server;

  afterEach(async () => {
    if (server?.isRunning?.()) {
      await server.stop();
    }
  });

  describe('constructor', () => {
    it('should create server instance with default configuration', () => {
      server = new Server();
      expect(server).toBeInstanceOf(Server);
      expect(server.config).toBeDefined();
      expect(server.config.port).toBeTypeOf('number');
      expect(server.config.host).toBeTypeOf('string');
    });

    it('should create server instance with custom configuration', () => {
      const customConfig: Partial<ServerConfig> = {
        port: 8080,
        host: 'localhost',
        timeout: 5000,
        maxConnections: 100
      };
      server = new Server(customConfig);
      expect(server.config.port).toBe(8080);
      expect(server.config.host).toBe('localhost');
      expect(server.config.timeout).toBe(5000);
      expect(server.config.maxConnections).toBe(100);
    });

    it('should merge custom config with defaults', () => {
      const partialConfig = { port: 9000 };
      server = new Server(partialConfig);
      expect(server.config.port).toBe(9000);
      expect(server.config.host).toBeDefined(); // Should have default
      expect(server.config.timeout).toBeDefined(); // Should have default
    });

    it('should throw error with invalid port configuration', () => {
      expect(() => new Server({ port: -1 })).toThrow('Invalid port number');
      expect(() => new Server({ port: 65536 })).toThrow('Invalid port number');
      expect(() => new Server({ port: 0 })).toThrow('Invalid port number');
    });

    it('should throw error with invalid host configuration', () => {
      expect(() => new Server({ host: '' })).toThrow('Invalid host');
      expect(() => new Server({ host: null as any })).toThrow('Invalid host');
    });

    it('should handle null/undefined configuration gracefully', () => {
      expect(() => new Server(null as any)).not.toThrow();
      expect(() => new Server(undefined)).not.toThrow();
      server = new Server();
      expect(server.config).toBeDefined();
    });

    it('should validate timeout configuration', () => {
      expect(() => new Server({ timeout: -1 })).toThrow('Invalid timeout value');
      expect(() => new Server({ timeout: 0 })).toThrow('Invalid timeout value');
      
      server = new Server({ timeout: 30000 });
      expect(server.config.timeout).toBe(30000);
    });

    it('should validate maxConnections configuration', () => {
      expect(() => new Server({ maxConnections: -1 })).toThrow('Invalid maxConnections value');
      expect(() => new Server({ maxConnections: 0 })).toThrow('Invalid maxConnections value');
      
      server = new Server({ maxConnections: 500 });
      expect(server.config.maxConnections).toBe(500);
    });
  });

  describe('configuration updates', () => {
    beforeEach(() => {
      server = new Server();
    });

    it('should update configuration dynamically', () => {
      const newConfig = { timeout: 10000, maxConnections: 200 };
      server.updateConfig(newConfig);
      expect(server.config.timeout).toBe(10000);
      expect(server.config.maxConnections).toBe(200);
    });

    it('should validate configuration updates', () => {
      expect(() => server.updateConfig({ port: -1 })).toThrow('Invalid port number');
      expect(() => server.updateConfig({ timeout: -1 })).toThrow('Invalid timeout value');
      expect(() => server.updateConfig({ host: '' })).toThrow('Invalid host');
    });

    it('should not update config when server is running', async () => {
      await server.start();
      expect(() => server.updateConfig({ port: 9000 })).toThrow('Cannot update config while server is running');
    });

    it('should preserve existing config when partial update fails', () => {
      const originalTimeout = server.config.timeout;
      expect(() => server.updateConfig({ timeout: -1, maxConnections: 100 })).toThrow();
      expect(server.config.timeout).toBe(originalTimeout);
    });
  });
});

describe('Server Lifecycle Management', () => {
  let server: Server;

  beforeEach(() => {
    server = new Server({ port: 3001 }); // Use non-default port for testing
  });

  afterEach(async () => {
    if (server?.isRunning?.()) {
      await server.stop();
    }
  });

  describe('start', () => {
    it('should start server successfully', async () => {
      const startSpy = spyOn(server, 'start');
      await server.start();
      
      expect(startSpy).toHaveBeenCalled();
      expect(server.isRunning()).toBe(true);
      expect(server.getPort()).toBe(3001);
      expect(server.getHost()).toBeDefined();
    });

    it('should emit start event', async () => {
      let startEmitted = false;
      server.on('start', () => { startEmitted = true; });
      
      await server.start();
      expect(startEmitted).toBe(true);
    });

    it('should handle start failure due to port in use', async () => {
      const server1 = new Server({ port: 3002 });
      const server2 = new Server({ port: 3002 });
      
      await server1.start();
      
      await expect(server2.start()).rejects.toThrow('Port 3002 is already in use');
      
      await server1.stop();
    });

    it('should not start if already running', async () => {
      await server.start();
      await expect(server.start()).rejects.toThrow('Server is already running');
    });

    it('should handle start timeout', async () => {
      const slowServer = new Server({ port: 3003, startTimeout: 100 });
      // Mock slow start
      slowServer.start = () => new Promise(resolve => setTimeout(resolve, 200));
      
      await expect(slowServer.start()).rejects.toThrow('Server start timeout');
    });

    it('should start with random port when port is 0', async () => {
      const randomPortServer = new Server({ port: 0 });
      await randomPortServer.start();
      
      expect(randomPortServer.getPort()).toBeGreaterThan(0);
      expect(randomPortServer.getPort()).not.toBe(0);
      
      await randomPortServer.stop();
    });

    it('should bind to all interfaces when host is 0.0.0.0', async () => {
      const allInterfacesServer = new Server({ port: 3004, host: '0.0.0.0' });
      await allInterfacesServer.start();
      
      expect(allInterfacesServer.getHost()).toBe('0.0.0.0');
      
      await allInterfacesServer.stop();
    });
  });

  describe('stop', () => {
    it('should stop server successfully', async () => {
      await server.start();
      expect(server.isRunning()).toBe(true);
      
      await server.stop();
      expect(server.isRunning()).toBe(false);
    });

    it('should emit stop event', async () => {
      let stopEmitted = false;
      server.on('stop', () => { stopEmitted = true; });
      
      await server.start();
      await server.stop();
      expect(stopEmitted).toBe(true);
    });

    it('should handle stop when not running', async () => {
      await expect(server.stop()).rejects.toThrow('Server is not running');
    });

    it('should force stop after timeout', async () => {
      await server.start();
      
      // Mock slow stop
      let forceStopCalled = false;
      server.forceStop = () => { forceStopCalled = true; return Promise.resolve(); };
      
      await server.stop(true);
      expect(forceStopCalled).toBe(true);
    });

    it('should handle active connections during stop', async () => {
      await server.start();
      
      // Simulate active connections
      server.getActiveConnections = () => 5;
      
      const stopPromise = server.stop();
      expect(server.getActiveConnections()).toBeGreaterThan(0);
      
      await stopPromise;
      expect(server.isRunning()).toBe(false);
    });

    it('should cleanup resources on stop', async () => {
      await server.start();
      const initialResources = server.getResourceCount();
      
      await server.stop();
      
      expect(server.getResourceCount()).toBeLessThan(initialResources);
    });
  });

  describe('restart', () => {
    it('should restart server successfully', async () => {
      await server.start();
      const originalPort = server.getPort();
      
      await server.restart();
      
      expect(server.isRunning()).toBe(true);
      expect(server.getPort()).toBe(originalPort);
    });

    it('should emit restart event', async () => {
      let restartEmitted = false;
      server.on('restart', () => { restartEmitted = true; });
      
      await server.start();
      await server.restart();
      expect(restartEmitted).toBe(true);
    });

    it('should handle restart when not running', async () => {
      await expect(server.restart()).rejects.toThrow('Cannot restart server that is not running');
    });

    it('should preserve configuration on restart', async () => {
      const originalConfig = { ...server.config };
      await server.start();
      
      await server.restart();
      
      expect(server.config).toEqual(originalConfig);
    });

    it('should handle restart failure', async () => {
      await server.start();
      
      // Mock restart failure
      server.start = () => Promise.reject(new Error('Restart failed'));
      
      await expect(server.restart()).rejects.toThrow('Restart failed');
    });
  });

  describe('status and information', () => {
    it('should return correct running status', async () => {
      expect(server.isRunning()).toBe(false);
      
      await server.start();
      expect(server.isRunning()).toBe(true);
      
      await server.stop();
      expect(server.isRunning()).toBe(false);
    });

    it('should return server information', async () => {
      await server.start();
      
      const info = server.getInfo();
      expect(info.port).toBe(server.getPort());
      expect(info.host).toBe(server.getHost());
      expect(info.isRunning).toBe(true);
      expect(info.uptime).toBeGreaterThanOrEqual(0);
      expect(info.startTime).toBeInstanceOf(Date);
    });

    it('should return base URL', async () => {
      await server.start();
      
      const baseUrl = server.getBaseUrl();
      expect(baseUrl).toMatch(/^https?:\/\/.+:\d+$/);
      expect(baseUrl).toContain(server.getPort().toString());
    });
  });
});

describe('Request Handling and HTTP Methods', () => {
  let server: Server;

  beforeEach(async () => {
    server = new Server({ port: 3005 });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  describe('HTTP Methods', () => {
    it('should handle GET requests', async () => {
      const mockHandler = mock((req, res) => {
        res.status(200).json({ method: 'GET', path: req.path });
      });
      
      server.get('/test', mockHandler);
      
      const response = await fetch(`${server.getBaseUrl()}/test`);
      const data = await response.json();
      
      expect(response.status).toBe(200);
      expect(data.method).toBe('GET');
      expect(data.path).toBe('/test');
      expect(mockHandler).toHaveBeenCalled();
    });

    it('should handle POST requests with JSON body', async () => {
      const mockHandler = mock((req, res) => {
        res.status(201).json({ received: req.body, method: 'POST' });
      });
      
      server.post('/test', mockHandler);
      
      const testData = { name: 'test', value: 123 };
      const response = await fetch(`${server.getBaseUrl()}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(testData)
      });
      
      const data = await response.json();
      
      expect(response.status).toBe(201);
      expect(data.received).toEqual(testData);
      expect(data.method).toBe('POST');
    });

    it('should handle PUT requests with parameters', async () => {
      const mockHandler = mock((req, res) => {
        res.status(200).json({ 
          id: req.params.id, 
          body: req.body,
          method: 'PUT' 
        });
      });
      
      server.put('/test/:id', mockHandler);
      
      const updateData = { name: 'updated' };
      const response = await fetch(`${server.getBaseUrl()}/test/123`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updateData)
      });
      
      const data = await response.json();
      
      expect(response.status).toBe(200);
      expect(data.id).toBe('123');
      expect(data.body).toEqual(updateData);
      expect(data.method).toBe('PUT');
    });

    it('should handle DELETE requests', async () => {
      const mockHandler = mock((req, res) => {
        res.status(204).json({ deleted: req.params.id });
      });
      
      server.delete('/test/:id', mockHandler);
      
      const response = await fetch(`${server.getBaseUrl()}/test/456`, {
        method: 'DELETE'
      });
      
      expect(response.status).toBe(204);
      expect(mockHandler).toHaveBeenCalled();
    });

    it('should handle PATCH requests', async () => {
      const mockHandler = mock((req, res) => {
        res.status(200).json({ 
          patched: true, 
          changes: req.body,
          id: req.params.id 
        });
      });
      
      server.patch('/test/:id', mockHandler);
      
      const patchData = { status: 'active' };
      const response = await fetch(`${server.getBaseUrl()}/test/789`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patchData)
      });
      
      const data = await response.json();
      
      expect(response.status).toBe(200);
      expect(data.patched).toBe(true);
      expect(data.changes).toEqual(patchData);
      expect(data.id).toBe('789');
    });

    it('should handle HEAD requests', async () => {
      const mockHandler = mock((req, res) => {
        res.status(200).set('X-Resource-Count', '42').end();
      });
      
      server.head('/test', mockHandler);
      
      const response = await fetch(`${server.getBaseUrl()}/test`, {
        method: 'HEAD'
      });
      
      expect(response.status).toBe(200);
      expect(response.headers.get('X-Resource-Count')).toBe('42');
    });

    it('should handle OPTIONS requests for CORS', async () => {
      const mockHandler = mock((req, res) => {
        res.status(200)
           .set('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE')
           .set('Access-Control-Allow-Headers', 'Content-Type,Authorization')
           .end();
      });
      
      server.options('/test', mockHandler);
      
      const response = await fetch(`${server.getBaseUrl()}/test`, {
        method: 'OPTIONS'
      });
      
      expect(response.status).toBe(200);
      expect(response.headers.get('Access-Control-Allow-Methods')).toContain('GET');
    });

    it('should return 404 for unhandled routes', async () => {
      const response = await fetch(`${server.getBaseUrl()}/nonexistent`);
      expect(response.status).toBe(404);
    });

    it('should return 405 for unsupported methods', async () => {
      server.get('/test', (req, res) => res.status(200).send());
      
      const response = await fetch(`${server.getBaseUrl()}/test`, {
        method: 'DELETE'
      });
      
      expect(response.status).toBe(405);
    });
  });

  describe('Query Parameters and Headers', () => {
    it('should parse query parameters', async () => {
      server.get('/search', (req, res) => {
        res.status(200).json({ 
          query: req.query,
          searchTerm: req.query.q,
          limit: parseInt(req.query.limit || '10')
        });
      });
      
      const response = await fetch(`${server.getBaseUrl()}/search?q=test&limit=20&sort=date`);
      const data = await response.json();
      
      expect(data.query.q).toBe('test');
      expect(data.query.limit).toBe('20');
      expect(data.query.sort).toBe('date');
      expect(data.searchTerm).toBe('test');
      expect(data.limit).toBe(20);
    });

    it('should handle request headers', async () => {
      server.get('/headers', (req, res) => {
        res.status(200).json({
          userAgent: req.headers['user-agent'],
          authorization: req.headers.authorization,
          customHeader: req.headers['x-custom-header']
        });
      });
      
      const response = await fetch(`${server.getBaseUrl()}/headers`, {
        headers: {
          'User-Agent': 'TestAgent/1.0',
          'Authorization': 'Bearer token123',
          'X-Custom-Header': 'custom-value'
        }
      });
      
      const data = await response.json();
      
      expect(data.userAgent).toContain('TestAgent/1.0');
      expect(data.authorization).toBe('Bearer token123');
      expect(data.customHeader).toBe('custom-value');
    });

    it('should set response headers', async () => {
      server.get('/response-headers', (req, res) => {
        res.set('X-Custom-Response', 'response-value')
           .set('Cache-Control', 'no-cache')
           .status(200)
           .json({ message: 'Headers set' });
      });
      
      const response = await fetch(`${server.getBaseUrl()}/response-headers`);
      
      expect(response.headers.get('X-Custom-Response')).toBe('response-value');
      expect(response.headers.get('Cache-Control')).toBe('no-cache');
    });
  });
});

describe('Middleware and Request Processing', () => {
  let server: Server;

  beforeEach(async () => {
    server = new Server({ port: 3006 });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  describe('Middleware Execution', () => {
    it('should execute middleware in correct order', async () => {
      const executionOrder: string[] = [];
      
      const middleware1 = mock((req, res, next) => {
        executionOrder.push('middleware1');
        req.customData = { step: 1 };
        next();
      });
      
      const middleware2 = mock((req, res, next) => {
        executionOrder.push('middleware2');
        req.customData.step = 2;
        next();
      });
      
      const handler = mock((req, res) => {
        executionOrder.push('handler');
        res.status(200).json({ 
          order: executionOrder,
          customData: req.customData 
        });
      });

      server.use(middleware1);
      server.use(middleware2);
      server.get('/test', handler);

      const response = await fetch(`${server.getBaseUrl()}/test`);
      const data = await response.json();

      expect(data.order).toEqual(['middleware1', 'middleware2', 'handler']);
      expect(data.customData.step).toBe(2);
      expect(middleware1).toHaveBeenCalled();
      expect(middleware2).toHaveBeenCalled();
      expect(handler).toHaveBeenCalled();
    });

    it('should stop execution when middleware does not call next', async () => {
      const middleware1 = mock((req, res, next) => {
        res.status(401).json({ error: 'Unauthorized' });
      });
      
      const middleware2 = mock((req, res, next) => {
        next();
      });
      
      const handler = mock((req, res) => {
        res.status(200).json({ message: 'Success' });
      });

      server.use(middleware1);
      server.use(middleware2);
      server.get('/test', handler);

      const response = await fetch(`${server.getBaseUrl()}/test`);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error).toBe('Unauthorized');
      expect(middleware1).toHaveBeenCalled();
      expect(middleware2).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
    });

    it('should handle middleware errors', async () => {
      const errorMiddleware = mock((req, res, next) => {
        next(new Error('Middleware error'));
      });
      
      const handler = mock((req, res) => {
        res.status(200).send();
      });

      server.use(errorMiddleware);
      server.get('/test', handler);

      const response = await fetch(`${server.getBaseUrl()}/test`);

      expect(response.status).toBe(500);
      expect(errorMiddleware).toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
    });

    it('should handle async middleware', async () => {
      const asyncMiddleware = mock(async (req, res, next) => {
        await new Promise(resolve => setTimeout(resolve, 10));
        req.asyncData = 'processed';
        next();
      });
      
      const handler = mock((req, res) => {
        res.status(200).json({ asyncData: req.asyncData });
      });

      server.use(asyncMiddleware);
      server.get('/test', handler);

      const response = await fetch(`${server.getBaseUrl()}/test`);
      const data = await response.json();

      expect(data.asyncData).toBe('processed');
    });
  });

  describe('Authentication and Authorization', () => {
    it('should handle JWT authentication middleware', async () => {
      const authMiddleware = mock((req, res, next) => {
        const token = req.headers.authorization?.replace('Bearer ', '');
        if (token === 'valid-token') {
          req.user = { id: 1, name: 'Test User' };
          next();
        } else {
          res.status(401).json({ error: 'Invalid token' });
        }
      });
      
      server.use('/protected', authMiddleware);
      server.get('/protected/data', (req, res) => {
        res.status(200).json({ user: req.user, data: 'secret data' });
      });

      // Test unauthorized access
      const unauthorizedResponse = await fetch(`${server.getBaseUrl()}/protected/data`);
      expect(unauthorizedResponse.status).toBe(401);

      // Test authorized access
      const authorizedResponse = await fetch(`${server.getBaseUrl()}/protected/data`, {
        headers: { 'Authorization': 'Bearer valid-token' }
      });
      const data = await authorizedResponse.json();
      
      expect(authorizedResponse.status).toBe(200);
      expect(data.user.name).toBe('Test User');
      expect(data.data).toBe('secret data');
    });

    it('should handle role-based authorization', async () => {
      const authMiddleware = mock((req, res, next) => {
        const token = req.headers.authorization?.replace('Bearer ', '');
        if (token === 'admin-token') {
          req.user = { role: 'admin' };
        } else if (token === 'user-token') {
          req.user = { role: 'user' };
        }
        next();
      });
      
      const adminOnlyMiddleware = mock((req, res, next) => {
        if (req.user?.role === 'admin') {
          next();
        } else {
          res.status(403).json({ error: 'Admin access required' });
        }
      });

      server.use(authMiddleware);
      server.get('/admin/users', adminOnlyMiddleware, (req, res) => {
        res.status(200).json({ users: ['user1', 'user2'] });
      });

      // Test user access (should be forbidden)
      const userResponse = await fetch(`${server.getBaseUrl()}/admin/users`, {
        headers: { 'Authorization': 'Bearer user-token' }
      });
      expect(userResponse.status).toBe(403);

      // Test admin access (should succeed)
      const adminResponse = await fetch(`${server.getBaseUrl()}/admin/users`, {
        headers: { 'Authorization': 'Bearer admin-token' }
      });
      expect(adminResponse.status).toBe(200);
    });
  });

  describe('Error Handling', () => {
    it('should handle synchronous errors in handlers', async () => {
      server.get('/error', (req, res) => {
        throw new Error('Synchronous error');
      });

      const response = await fetch(`${server.getBaseUrl()}/error`);
      expect(response.status).toBe(500);
    });

    it('should handle asynchronous errors in handlers', async () => {
      server.get('/async-error', async (req, res) => {
        await new Promise(resolve => setTimeout(resolve, 10));
        throw new Error('Asynchronous error');
      });

      const response = await fetch(`${server.getBaseUrl()}/async-error`);
      expect(response.status).toBe(500);
    });

    it('should handle custom error responses', async () => {
      server.get('/custom-error', (req, res) => {
        const error = new Error('Custom error');
        (error as any).statusCode = 422;
        (error as any).details = { field: 'invalid' };
        throw error;
      });

      const response = await fetch(`${server.getBaseUrl()}/custom-error`);
      const data = await response.json();
      
      expect(response.status).toBe(422);
      expect(data.error).toBeDefined();
    });

    it('should handle error middleware', async () => {
      const errorHandler = mock((err: any, req: any, res: any, next: any) => {
        res.status(err.statusCode || 500).json({
          error: err.message,
          timestamp: new Date().toISOString(),
          path: req.path
        });
      });
      
      server.get('/test-error', (req, res) => {
        const error = new Error('Test error');
        (error as any).statusCode = 400;
        throw error;
      });
      
      server.use(errorHandler);

      const response = await fetch(`${server.getBaseUrl()}/test-error`);
      const data = await response.json();
      
      expect(response.status).toBe(400);
      expect(data.error).toBe('Test error');
      expect(data.timestamp).toBeDefined();
      expect(data.path).toBe('/test-error');
    });
  });
});

describe('Health Checks, Metrics and Monitoring', () => {
  let server: Server;

  beforeEach(async () => {
    server = new Server({ port: 3007 });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  describe('Health Checks', () => {
    it('should return basic health status', async () => {
      const health = await server.getHealth();
      
      expect(health.status).toBe('healthy');
      expect(health.uptime).toBeGreaterThan(0);
      expect(health.timestamp).toBeInstanceOf(Date);
      expect(health.version).toBeDefined();
      expect(health.environment).toBeDefined();
    });

    it('should return unhealthy status when server has issues', async () => {
      // Mock a health issue
      server.addHealthCheck('memory', () => false);
      
      const health = await server.getHealth();
      expect(health.status).toBe('unhealthy');
      expect(health.checks.memory).toBe(false);
    });

    it('should add and execute custom health checks', async () => {
      let dbHealthy = true;
      let cacheHealthy = true;
      
      server.addHealthCheck('database', async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        return dbHealthy;
      });
      
      server.addHealthCheck('cache', () => Promise.resolve(cacheHealthy));

      const health = await server.getHealth();
      
      expect(health.checks.database).toBe(true);
      expect(health.checks.cache).toBe(true);
      
      // Test failing health checks
      dbHealthy = false;
      const unhealthyState = await server.getHealth();
      expect(unhealthyState.status).toBe('unhealthy');
      expect(unhealthyState.checks.database).toBe(false);
    });

    it('should handle health check timeouts', async () => {
      server.addHealthCheck('slow-service', () => 
        new Promise(resolve => setTimeout(() => resolve(true), 5000))
      );
      
      const health = await server.getHealth({ timeout: 100 });
      expect(health.checks['slow-service']).toBe('timeout');
    });

    it('should provide detailed health information', async () => {
      server.addHealthCheck('detailed', () => ({
        status: 'healthy',
        responseTime: 25,
        connections: 42,
        details: { version: '1.0.0' }
      }));
      
      const health = await server.getHealth();
      const detailedCheck = (health.checks as any).detailed;
      
      expect(detailedCheck.status).toBe('healthy');
      expect(detailedCheck.responseTime).toBe(25);
      expect(detailedCheck.connections).toBe(42);
      expect(detailedCheck.details.version).toBe('1.0.0');
    });

    it('should expose health check endpoint', async () => {
      server.addHealthCheck('api', () => true);
      
      const response = await fetch(`${server.getBaseUrl()}/health`);
      const health = await response.json();
      
      expect(response.status).toBe(200);
      expect(health.status).toBe('healthy');
      expect(health.checks.api).toBe(true);
    });
  });

  describe('Metrics Collection', () => {
    it('should track basic request metrics', async () => {
      server.get('/metric-test', (req, res) => res.status(200).send());
      
      // Make several requests
      await fetch(`${server.getBaseUrl()}/metric-test`);
      await fetch(`${server.getBaseUrl()}/metric-test`);
      await fetch(`${server.getBaseUrl()}/nonexistent`); // 404
      
      const metrics = server.getMetrics();
      
      expect(metrics.totalRequests).toBeGreaterThanOrEqual(3);
      expect(metrics.successfulRequests).toBeGreaterThanOrEqual(2);
      expect(metrics.errorRequests).toBeGreaterThanOrEqual(1);
      expect(metrics.responseTimeAverage).toBeGreaterThan(0);
    });

    it('should track response time metrics', async () => {
      server.get('/slow', async (req, res) => {
        await new Promise(resolve => setTimeout(resolve, 50));
        res.status(200).send();
      });
      
      server.get('/fast', (req, res) => res.status(200).send());
      
      await fetch(`${server.getBaseUrl()}/slow`);
      await fetch(`${server.getBaseUrl()}/fast`);
      
      const metrics = server.getMetrics();
      
      expect(metrics.responseTimeMax).toBeGreaterThan(40);
      expect(metrics.responseTimeMin).toBeGreaterThan(0);
      expect(metrics.responseTimeAverage).toBeGreaterThan(0);
    });

    it('should track status code distribution', async () => {
      server.get('/ok', (req, res) => res.status(200).send());
      server.get('/created', (req, res) => res.status(201).send());
      server.get('/error', (req, res) => res.status(500).send());
      
      await fetch(`${server.getBaseUrl()}/ok`);
      await fetch(`${server.getBaseUrl()}/created`);
      await fetch(`${server.getBaseUrl()}/error`);
      
      const metrics = server.getMetrics();
      
      expect(metrics.statusCodes['200']).toBeGreaterThanOrEqual(1);
      expect(metrics.statusCodes['201']).toBeGreaterThanOrEqual(1);
      expect(metrics.statusCodes['500']).toBeGreaterThanOrEqual(1);
    });

    it('should track concurrent connections', async () => {
      server.get('/concurrent', async (req, res) => {
        await new Promise(resolve => setTimeout(resolve, 100));
        res.status(200).send();
      });
      
      // Start concurrent requests
      const requests = Array.from({ length: 5 }, () => 
        fetch(`${server.getBaseUrl()}/concurrent`)
      );
      
      // Check metrics during concurrent requests
      await new Promise(resolve => setTimeout(resolve, 50));
      const metrics = server.getMetrics();
      expect(metrics.activeConnections).toBeGreaterThan(0);
      
      await Promise.all(requests);
    });

    it('should provide memory usage metrics', () => {
      const metrics = server.getMetrics();
      
      expect(metrics.memory).toBeDefined();
      expect(metrics.memory.heapUsed).toBeGreaterThan(0);
      expect(metrics.memory.heapTotal).toBeGreaterThan(0);
      expect(metrics.memory.rss).toBeGreaterThan(0);
    });

    it('should reset metrics', async () => {
      server.get('/test', (req, res) => res.status(200).send());
      await fetch(`${server.getBaseUrl()}/test`);
      
      let metrics = server.getMetrics();
      expect(metrics.totalRequests).toBeGreaterThan(0);
      
      server.resetMetrics();
      metrics = server.getMetrics();
      expect(metrics.totalRequests).toBe(0);
    });
  });

  describe('Monitoring and Alerts', () => {
    it('should emit events for monitoring', async () => {
      let requestEvent: any = null;
      let errorEvent: any = null;
      
      server.on('request', (event) => { requestEvent = event; });
      server.on('error', (event) => { errorEvent = event; });
      
      server.get('/monitor-test', (req, res) => res.status(200).send());
      server.get('/monitor-error', (req, res) => { throw new Error('Test error'); });
      
      await fetch(`${server.getBaseUrl()}/monitor-test`);
      await fetch(`${server.getBaseUrl()}/monitor-error`);
      
      expect(requestEvent).toBeDefined();
      expect(requestEvent.method).toBe('GET');
      expect(requestEvent.path).toBe('/monitor-test');
      
      expect(errorEvent).toBeDefined();
      expect(errorEvent.error).toContain('Test error');
    });

    it('should handle resource limits and alerts', async () => {
      let alertTriggered = false;
      server.on('resource-alert', () => { alertTriggered = true; });
      
      // Mock high resource usage
      const originalGetMetrics = server.getMetrics;
      server.getMetrics = () => ({
        ...originalGetMetrics.call(server),
        memory: { heapUsed: 1024 * 1024 * 1024 }, // 1GB
        activeConnections: 1000
      });
      
      server.checkResourceLimits();
      expect(alertTriggered).toBe(true);
    });
  });
});

describe('Edge Cases and Error Scenarios', () => {
  let server: Server;

  afterEach(async () => {
    if (server?.isRunning?.()) {
      await server.stop();
    }
  });

  describe('Resource Management and Limits', () => {
    it('should handle memory pressure gracefully', async () => {
      server = new Server({ port: 3008, memoryLimit: 100 * 1024 * 1024 }); // 100MB
      await server.start();
      
      // Mock high memory usage
      const mockMemoryUsage = spyOn(process, 'memoryUsage').mockReturnValue({
        rss: 150 * 1024 * 1024, // 150MB
        heapTotal: 120 * 1024 * 1024,
        heapUsed: 110 * 1024 * 1024,
        external: 0,
        arrayBuffers: 0
      });

      const health = await server.getHealth();
      expect(health.status).toBe('unhealthy');
      expect(health.checks.memory).toBe(false);
      
      mockMemoryUsage.mockRestore();
    });

    it('should handle connection limits', async () => {
      server = new Server({ port: 3009, maxConnections: 2 });
      await server.start();
      
      server.get('/slow', async (req, res) => {
        await new Promise(resolve => setTimeout(resolve, 200));
        res.status(200).send();
      });

      // Start requests that exceed connection limit
      const requests = Array.from({ length: 5 }, () => 
        fetch(`${server.getBaseUrl()}/slow`)
      );

      const responses = await Promise.all(requests.map(r => r.catch(e => ({ status: 503 }))));
      const rejectedCount = responses.filter(r => r.status === 503).length;
      
      expect(rejectedCount).toBeGreaterThan(0);
    });

    it('should handle concurrent requests efficiently', async () => {
      server = new Server({ port: 3010 });
      await server.start();
      
      server.get('/concurrent', (req, res) => {
        const delay = Math.random() * 50;
        setTimeout(() => res.status(200).json({ delay }), delay);
      });

      const concurrentRequests = 50;
      const startTime = Date.now();
      
      const requests = Array.from({ length: concurrentRequests }, () => 
        fetch(`${server.getBaseUrl()}/concurrent`)
      );

      const responses = await Promise.all(requests);
      const endTime = Date.now();

      expect(responses.every(r => r.status === 200)).toBe(true);
      expect(endTime - startTime).toBeLessThan(2000); // Should complete within 2 seconds
    });
  });

  describe('Input Validation and Security', () => {
    beforeEach(async () => {
      server = new Server({ port: 3011 });
      await server.start();
    });

    it('should handle malformed JSON requests', async () => {
      server.post('/json', (req, res) => res.status(200).json(req.body));

      const response = await fetch(`${server.getBaseUrl()}/json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"invalid": json}'
      });

      expect(response.status).toBe(400);
    });

    it('should handle extremely large payloads', async () => {
      server.post('/upload', (req, res) => res.status(200).send());

      const largePayload = 'x'.repeat(20 * 1024 * 1024); // 20MB
      const response = await fetch(`${server.getBaseUrl()}/upload`, {
        method: 'POST',
        body: largePayload
      });

      expect([413, 400, 500]).toContain(response.status);
    });

    it('should handle special characters in URLs', async () => {
      server.get('/special/:param', (req, res) => {
        res.status(200).json({ param: req.params.param });
      });

      const specialChars = ['%20', '%3C', '%3E', '%22', '%27'];
      for (const char of specialChars) {
        const response = await fetch(`${server.getBaseUrl()}/special/test${char}value`);
        if (response.status === 200) {
          const data = await response.json();
          expect(data.param).toBeDefined();
        }
      }
    });

    it('should prevent path traversal attacks', async () => {
      server.get('/file/:filename', (req, res) => {
        const filename = req.params.filename;
        if (filename.includes('..') || filename.includes('/')) {
          res.status(400).json({ error: 'Invalid filename' });
        } else {
          res.status(200).json({ filename });
        }
      });

      const maliciousInputs = ['../../../etc/passwd', '..\\windows\\system32', 'file/../../../secret'];
      
      for (const input of maliciousInputs) {
        const response = await fetch(`${server.getBaseUrl()}/file/${encodeURIComponent(input)}`);
        expect(response.status).toBe(400);
      }
    });

    it('should handle SQL injection attempts in parameters', async () => {
      server.get('/user/:id', (req, res) => {
        const id = req.params.id;
        // Simulate basic SQL injection protection
        if (/[;'"\\]/.test(id)) {
          res.status(400).json({ error: 'Invalid user ID' });
        } else {
          res.status(200).json({ userId: id });
        }
      });

      const sqlInjectionAttempts = [
        "1'; DROP TABLE users; --",
        "1' OR '1'='1",
        '1" OR "1"="1',
        "1; DELETE FROM users WHERE 1=1; --"
      ];

      for (const attempt of sqlInjectionAttempts) {
        const response = await fetch(`${server.getBaseUrl()}/user/${encodeURIComponent(attempt)}`);
        expect(response.status).toBe(400);
      }
    });
  });

  describe('Timeout and Connection Handling', () => {
    it('should handle request timeouts', async () => {
      server = new Server({ port: 3012, requestTimeout: 100 });
      await server.start();
      
      server.get('/timeout', async (req, res) => {
        await new Promise(resolve => setTimeout(resolve, 200));
        res.status(200).send();
      });

      const response = await fetch(`${server.getBaseUrl()}/timeout`);
      expect([408, 504]).toContain(response.status);
    });

    it('should handle connection drops gracefully', async () => {
      server = new Server({ port: 3013 });
      await server.start();
      
      let connectionDropped = false;
      server.on('connection-dropped', () => { connectionDropped = true; });
      
      server.get('/drop-test', (req, res) => {
        // Simulate connection drop
        (req as any).socket.destroy();
      });

      try {
        await fetch(`${server.getBaseUrl()}/drop-test`);
      } catch {
        // Expected failure
      }
      
      // Allow event emission
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(connectionDropped).toBe(true);
    });

    it('should handle keep-alive connections', async () => {
      server = new Server({ port: 3014, keepAliveTimeout: 5000 });
      await server.start();
      
      server.get('/keep-alive', (req, res) => {
        res.set('Connection', 'keep-alive');
        res.status(200).send();
      });

      for (let i = 0; i < 3; i++) {
        const response = await fetch(`${server.getBaseUrl()}/keep-alive`);
        expect(response.status).toBe(200);
      }
    });
  });

  describe('Cleanup and Resource Management', () => {
    it('should clean up resources on stop', async () => {
      server = new Server({ port: 3015 });
      await server.start();

      const initialHandles = (process as any)._getActiveHandles?.()?.length || 0;
      const initialRequests = (process as any)._getActiveRequests?.()?.length || 0;
      
      await server.stop();
      await new Promise(resolve => setTimeout(resolve, 100));
      
      const finalHandles = (process as any)._getActiveHandles?.()?.length || 0;
      const finalRequests = (process as any)._getActiveRequests?.()?.length || 0;
      
      expect(finalHandles).toBeLessThanOrEqual(initialHandles);
      expect(finalRequests).toBeLessThanOrEqual(initialRequests);
    });

    it('should handle multiple start/stop cycles without resource leaks', async () => {
      server = new Server({ port: 3016 });

      for (let i = 0; i < 5; i++) {
        await server.start();
        expect(server.isRunning()).toBe(true);
        
        server.get('/cycle-test', (req, res) => res.status(200).send());
        const response = await fetch(`${server.getBaseUrl()}/cycle-test`);
        expect(response.status).toBe(200);
        
        await server.stop();
        expect(server.isRunning()).toBe(false);
      }
    });

    it('should handle graceful shutdown with active requests', async () => {
      server = new Server({ port: 3017, gracefulShutdownTimeout: 1000 });
      await server.start();
      
      server.get('/long-running', async (req, res) => {
        await new Promise(resolve => setTimeout(resolve, 500));
        res.status(200).json({ completed: true });
      });

      const requestPromise = fetch(`${server.getBaseUrl()}/long-running`);
      await new Promise(resolve => setTimeout(resolve, 100));
      const shutdownPromise = server.stop();
      
      const [response] = await Promise.all([requestPromise, shutdownPromise]);
      expect(response.status).toBe(200);
    });
  });
});

// Global test cleanup
afterAll(async () => {
  // Ensure all resources are cleaned up
  await new Promise(resolve => setTimeout(resolve, 200));
  
  // Force garbage collection if available
  if (global.gc) {
    global.gc();
  }
});