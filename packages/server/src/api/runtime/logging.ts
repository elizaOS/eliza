import { logger } from '@elizaos/core';
import express from 'express';

// Custom levels from @elizaos/core logger
const LOG_LEVELS = {
  fatal: 60,
  error: 50,
  warn: 40,
  info: 30,
  log: 29,
  progress: 28,
  success: 27,
  debug: 20,
  trace: 10,
} as const;

/**
 * Defines a type `LogLevel` as the keys of the `LOG_LEVELS` object.
 */
type LogLevel = keyof typeof LOG_LEVELS | 'all';

/**
 * Represents a log entry with specific properties.
 */
interface LogEntry {
  level: number;
  time: number;
  msg: string;
  [key: string]: string | number | boolean | null | undefined;
}

/**
 * Logging management endpoints
 */
export function createLoggingRouter(): express.Router {
  const router = express.Router();

  // Logs endpoint handler
  const logsHandler = async (req: express.Request, res: express.Response) => {
    const since = req.query.since ? Number(req.query.since) : Date.now() - 3600000; // Default 1 hour
    const requestedLevel = (req.query.level?.toString().toLowerCase() || 'all') as LogLevel;
    const requestedAgentName = req.query.agentName?.toString() || 'all';
    const requestedAgentId = req.query.agentId?.toString() || 'all'; // Add support for agentId parameter
    const limit = Math.min(Number(req.query.limit) || 100, 1000); // Max 1000 entries

    // Access the underlying logger instance
    const destination = (logger as any)[Symbol.for('pino-destination')];

    if (!destination?.recentLogs) {
      return res.status(500).json({
        error: 'Logger destination not available',
        message: 'The logger is not configured to maintain recent logs',
      });
    }

    try {
      // Get logs from the destination's buffer
      const recentLogs: LogEntry[] = destination.recentLogs();
      const requestedLevelValue =
        requestedLevel === 'all'
          ? 0 // Show all levels when 'all' is requested
          : LOG_LEVELS[requestedLevel as keyof typeof LOG_LEVELS] || LOG_LEVELS.info;

      // Calculate population rates once for efficiency
      const logsWithAgentNames = recentLogs.filter((l) => l.agentName).length;
      const logsWithAgentIds = recentLogs.filter((l) => l.agentId).length;
      const totalLogs = recentLogs.length;
      const agentNamePopulationRate = totalLogs > 0 ? logsWithAgentNames / totalLogs : 0;
      const agentIdPopulationRate = totalLogs > 0 ? logsWithAgentIds / totalLogs : 0;

      // If less than 10% of logs have agent metadata, be lenient with filtering
      const isAgentNameDataSparse = agentNamePopulationRate < 0.1;
      const isAgentIdDataSparse = agentIdPopulationRate < 0.1;

      const filtered = recentLogs
        .filter((log) => {
          // Filter by time always
          const timeMatch = log.time >= since;

          // Filter by level - return all logs if requestedLevel is 'all'
          let levelMatch = true;
          if (requestedLevel && requestedLevel !== 'all') {
            levelMatch = log.level === requestedLevelValue;
          }

          // Filter by agentName if provided - return all if 'all'
          let agentNameMatch = true;
          if (requestedAgentName && requestedAgentName !== 'all') {
            if (log.agentName) {
              // If the log has an agentName, match it exactly
              agentNameMatch = log.agentName === requestedAgentName;
            } else {
              // If log has no agentName but most logs lack agentNames, show all logs
              // This handles the case where logs aren't properly tagged with agent names
              agentNameMatch = isAgentNameDataSparse;
            }
          }

          // Filter by agentId if provided - return all if 'all'
          let agentIdMatch = true;
          if (requestedAgentId && requestedAgentId !== 'all') {
            if (log.agentId) {
              // If the log has an agentId, match it exactly
              agentIdMatch = log.agentId === requestedAgentId;
            } else {
              // If log has no agentId but most logs lack agentIds, show all logs
              agentIdMatch = isAgentIdDataSparse;
            }
          }

          return timeMatch && levelMatch && agentNameMatch && agentIdMatch;
        })
        .slice(-limit);

      // Add debug log to help troubleshoot
      logger.debug('Logs request processed', {
        requestedLevel,
        requestedLevelValue,
        requestedAgentName,
        requestedAgentId,
        filteredCount: filtered.length,
        totalLogs: recentLogs.length,
        logsWithAgentNames,
        logsWithAgentIds,
        agentNamePopulationRate: Math.round(agentNamePopulationRate * 100) + '%',
        agentIdPopulationRate: Math.round(agentIdPopulationRate * 100) + '%',
        isAgentNameDataSparse,
        isAgentIdDataSparse,
        sampleLogAgentNames: recentLogs.slice(0, 5).map((log) => log.agentName),
        uniqueAgentNamesInLogs: [...new Set(recentLogs.map((log) => log.agentName))].filter(
          Boolean
        ),
        exactAgentNameMatches: recentLogs.filter((log) => log.agentName === requestedAgentName)
          .length,
      });

      res.json({
        logs: filtered,
        count: filtered.length,
        total: recentLogs.length,
        requestedLevel: requestedLevel,
        agentName: requestedAgentName,
        agentId: requestedAgentId,
        levels: Object.keys(LOG_LEVELS),
      });
    } catch (error) {
      res.status(500).json({
        error: 'Failed to retrieve logs',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  };

  // GET and POST endpoints for logs
  (router as any).get('/logs', logsHandler);
  (router as any).post('/logs', logsHandler);

  // Handler for clearing logs
  const logsClearHandler = (_req: express.Request, res: express.Response) => {
    try {
      // Access the underlying logger instance
      const destination = (logger as any)[Symbol.for('pino-destination')];

      if (!destination?.clear) {
        return res.status(500).json({
          error: 'Logger clear method not available',
          message: 'The logger is not configured to clear logs',
        });
      }

      // Clear the logs
      destination.clear();

      logger.debug('Logs cleared via API endpoint');
      res.json({ status: 'success', message: 'Logs cleared successfully' });
    } catch (error) {
      res.status(500).json({
        error: 'Failed to clear logs',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  };

  // DELETE endpoint for clearing logs
  (router as any).delete('/logs', logsClearHandler);

  return router;
}
