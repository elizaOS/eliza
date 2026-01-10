import express from 'express';
import { Server } from 'socket.io';
import { createServer } from 'http';
import cors from 'cors';
import { type IAgentRuntime } from '@elizaos/core';
import { OODALoopService } from './ooda-service';
import { AutonomyLogger } from './logging';

export class AutonomyAPIServer {
  private app: express.Application;
  private server: any;
  private io: Server;
  private logger: AutonomyLogger;
  private oodaService: OODALoopService | null = null;
  private port: number;

  constructor(
    private runtime: IAgentRuntime,
    port: number = 3001
  ) {
    this.app = express();
    this.server = createServer(this.app);
    this.io = new Server(this.server, {
      cors: {
        origin: '*',
        methods: ['GET', 'POST'],
      },
    });
    this.logger = new AutonomyLogger(runtime);
    this.port = port;

    this.setupMiddleware();
    this.setupRoutes();
    this.setupWebSocket();
  }

  private setupMiddleware() {
    this.app.use(cors());
    this.app.use(express.json());

    // Request logging
    this.app.use((req, res, next) => {
      this.logger.info(`API Request: ${req.method} ${req.path}`, {
        query: req.query,
        body: req.body,
      });
      next();
    });
  }

  private setupRoutes() {
    // Health check
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'ok',
        agent: this.runtime.agentId,
        oodaActive: this.oodaService !== null,
        timestamp: Date.now(),
      });
    });

    // Get current OODA context
    this.app.get('/api/ooda/context', (req, res) => {
      if (!this.oodaService) {
        return res.status(503).json({ error: 'OODA service not initialized' });
      }

      const context = (this.oodaService as any).currentContext;
      if (!context) {
        return res.status(404).json({ error: 'No active OODA context' });
      }

      res.json(context);
    });

    // Get OODA metrics
    this.app.get('/api/ooda/metrics', (req, res) => {
      if (!this.oodaService) {
        return res.status(503).json({ error: 'OODA service not initialized' });
      }

      const context = (this.oodaService as any).currentContext;
      if (!context) {
        return res.status(404).json({ error: 'No active OODA context' });
      }

      res.json(context.metrics);
    });

    // Get logs
    this.app.get('/api/logs', async (req, res) => {
      const { runId, phase, level, limit = 100 } = req.query;

      try {
        const logs = await this.logger.queryLogs({
          runId: runId as string,
          phase: phase as any,
          level: level as any,
          limit: parseInt(limit as string),
        });

        res.json(logs);
      } catch (error) {
        res
          .status(500)
          .json({ error: 'Failed to retrieve logs', details: (error as Error).message });
      }
    });

    // Get goals
    this.app.get('/api/goals', (req, res) => {
      if (!this.oodaService) {
        return res.status(503).json({ error: 'OODA service not initialized' });
      }

      const goals = (this.oodaService as any).goals;
      res.json(goals);
    });

    // Update goal progress
    this.app.put('/api/goals/:id/progress', (req, res) => {
      if (!this.oodaService) {
        return res.status(503).json({ error: 'OODA service not initialized' });
      }

      const { id } = req.params;
      const { progress } = req.body;

      const goals = (this.oodaService as any).goals;
      const goal = goals.find((g: any) => g.id === id);

      if (!goal) {
        return res.status(404).json({ error: 'Goal not found' });
      }

      goal.progress = progress;
      res.json(goal);
    });

    // Get recent observations
    this.app.get('/api/observations', (req, res) => {
      if (!this.oodaService) {
        return res.status(503).json({ error: 'OODA service not initialized' });
      }

      const context = (this.oodaService as any).currentContext;
      if (!context) {
        return res.status(404).json({ error: 'No active OODA context' });
      }

      res.json(context.observations);
    });

    // Get recent actions
    this.app.get('/api/actions', (req, res) => {
      if (!this.oodaService) {
        return res.status(503).json({ error: 'OODA service not initialized' });
      }

      const context = (this.oodaService as any).currentContext;
      if (!context) {
        return res.status(404).json({ error: 'No active OODA context' });
      }

      res.json(context.actions);
    });

    // Error handler
    this.app.use(
      (err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
        this.logger.error('API Server Error', err);
        res.status(500).json({
          error: 'Internal server error',
          message: err.message,
        });
      }
    );
  }

  private setupWebSocket() {
    this.io.on('connection', (socket) => {
      this.logger.info('WebSocket client connected', { socketId: socket.id });

      // Send initial state
      if (this.oodaService) {
        const context = (this.oodaService as any).currentContext;
        if (context) {
          socket.emit('ooda:context', context);
        }
      }

      socket.on('disconnect', () => {
        this.logger.info('WebSocket client disconnected', { socketId: socket.id });
      });

      // Allow clients to request specific data
      socket.on('request:context', () => {
        if (this.oodaService) {
          const context = (this.oodaService as any).currentContext;
          socket.emit('ooda:context', context);
        }
      });

      socket.on('request:metrics', () => {
        if (this.oodaService) {
          const context = (this.oodaService as any).currentContext;
          if (context) {
            socket.emit('ooda:metrics', context.metrics);
          }
        }
      });
    });
  }

  setOODAService(service: OODALoopService) {
    this.oodaService = service;

    // Hook into OODA events to broadcast updates
    const originalExecute = (service as any).executeOODACycle;
    (service as any).executeOODACycle = async function (this: any) {
      const result = await originalExecute.call(this);

      // Broadcast updates
      if ((service as any).currentContext) {
        this.io.emit('ooda:context', (service as any).currentContext);
        this.io.emit('ooda:metrics', (service as any).currentContext.metrics);
      }

      return result;
    }.bind(this);
  }

  async start() {
    return new Promise<void>((resolve) => {
      this.server.listen(this.port, () => {
        this.logger.info(`Autonomy API Server listening on port ${this.port}`);
        resolve();
      });
    });
  }

  async stop() {
    return new Promise<void>((resolve) => {
      this.io.disconnectSockets();
      this.server.close(() => {
        this.logger.info('Autonomy API Server stopped');
        resolve();
      });
    });
  }
}
