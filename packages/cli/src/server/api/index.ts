import type { IAgentRuntime, UUID } from '@elizaos/core';
import { getEnvVariable, logger } from '@elizaos/core';
import * as bodyParser from 'body-parser';
import cors from 'cors';
import express from 'express';
import type { AgentServer } from '..';
import { agentRouter } from './agent.ts';
import { teeRouter } from './tee.ts';


// Custom levels from @elizaos/core logger
const LOG_LEVELS = {
    ...logger.levels.values
} as const;

type LogLevel = keyof typeof LOG_LEVELS;

interface LogEntry {
    level: number;
    time: number;
    msg: string;
    [key: string]: string | number | boolean | null | undefined;
}

export function createApiRouter(
    agents: Map<UUID, IAgentRuntime>,
    server?: AgentServer,
): express.Router {
    const router = express.Router();

    // Setup middleware
    router.use(cors());
    router.use(bodyParser.json());
    router.use(bodyParser.urlencoded({ extended: true }));
    router.use(
        express.json({
            limit: getEnvVariable('EXPRESS_MAX_PAYLOAD') || '100kb',
        })
    );

    // Base routes
    router.get('/', (_req, res) => {
        res.send('Welcome, this is the REST API!');
    });

    router.get('/hello', (_req, res) => {
        res.json({ message: 'Hello World!' });
    });

    // Mount sub-routers
    router.use('/agents', agentRouter(agents, server));
    router.use('/tee', teeRouter(agents));

    router.get('/stop', (_req, res) => {
        server.stop();
        res.json({ message: 'Server stopping...' });
    });


    // Logs endpoint
    const logsHandler = (req, res) => {
        const since = req.query.since ? Number(req.query.since) : Date.now() - 3600000; // Default 1 hour
        const requestedLevel = (req.query.level?.toString().toLowerCase() || 'info') as LogLevel;
        const limit = Math.min(Number(req.query.limit) || 100, 1000); // Max 1000 entries
        
        // Access the underlying logger instance
        const destination = (logger as unknown)[Symbol.for('pino-destination')];
        
        if (!destination?.recentLogs) {
            return res.status(500).json({ 
                error: 'Logger destination not available',
                message: 'The logger is not configured to maintain recent logs'
            });
        }

        try {
            // Get logs from the destination's buffer
            const recentLogs: LogEntry[] = destination.recentLogs();
            const requestedLevelValue = LOG_LEVELS[requestedLevel] || LOG_LEVELS.info;
            
            const filtered = recentLogs
                .filter(log => {
                    return log.time >= since && 
                           log.level >= requestedLevelValue;
                })
                .slice(-limit);

            res.json({
                logs: filtered,
                count: filtered.length,
                total: recentLogs.length,
                level: requestedLevel,
                levels: Object.keys(LOG_LEVELS)
            });
        } catch (error) {
            res.status(500).json({ 
                error: 'Failed to retrieve logs',
                message: error instanceof Error ? error.message : 'Unknown error'
            });
        }
    };
    
    router.get('/logs', logsHandler);

    // Health check endpoints
    router.get('/health', (_req, res) => {
        const healthcheck = {
            status: 'OK',
            version: process.env.APP_VERSION || 'unknown',
            timestamp: new Date().toISOString(),
            dependencies: {
                agents: agents.size > 0 ? 'healthy' : 'no_agents'
            }
        };
        
        const statusCode = healthcheck.dependencies.agents === 'healthy' ? 200 : 503;
        res.status(statusCode).json(healthcheck);
    });

    // Status endpoint
    router.get('/status', (_req, res) => {
        res.json({
            status: 'operational',
            version: process.env.APP_VERSION || 'unknown',
            uptime: process.uptime(),
            timestamp: new Date().toISOString(),
            system: {
                platform: process.platform,
                memory: process.memoryUsage(),
                env: process.env.NODE_ENV
            },
            dependencies: {
                totalAgents: agents.size,
            }
        });
    });


    return router;
}

