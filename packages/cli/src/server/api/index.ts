import type { IAgentRuntime, UUID } from "@elizaos/core";
import { getEnvVariable, logger } from "@elizaos/core";
import * as bodyParser from "body-parser";
import cors from "cors";
import express from "express";
import type { AgentServer } from "..";
import { agentRouter } from "./agent";
import { teeRouter } from "./tee";
import path from "node:path";
import fs from "node:fs";

// Custom levels from @elizaos/core logger
const LOG_LEVELS = {
	...logger.levels.values,
} as const;

/**
 * Defines a type `LogLevel` as the keys of the `LOG_LEVELS` object.
 */
type LogLevel = keyof typeof LOG_LEVELS;

/**
 * Represents a log entry with specific properties.
 * @typedef {Object} LogEntry
 * @property {number} level - The level of the log entry.
 * @property {number} time - The time the log entry was created.
 * @property {string} msg - The message of the log entry.
 * @property {string | number | boolean | null | undefined} [key] - Additional key-value pairs for the log entry.
 */
interface LogEntry {
	level: number;
	time: number;
	msg: string;
	[key: string]: string | number | boolean | null | undefined;
}

/**
 * Creates an API router with various endpoints and middleware.
 * @param {Map<UUID, IAgentRuntime>} agents - Map of agents with UUID as key and IAgentRuntime as value.
 * @param {AgentServer} [server] - Optional AgentServer instance.
 * @returns {express.Router} The configured API router.
 */
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
			limit: getEnvVariable("EXPRESS_MAX_PAYLOAD") || "100kb",
		}),
	);

	router.get("/hello", (_req, res) => {
		res.json({ message: "Hello World!" });
	});

	// Plugin routes handling middleware
	// This middleware needs to be registered before the other routes
	// to ensure plugin routes take precedence
	router.use((req, res, next) => {
		// Debug output for all JavaScript requests to help diagnose MIME type issues
		if (
			req.path.endsWith(".js") ||
			req.path.includes(".js?") ||
			req.path.match(/index-[A-Za-z0-9]{8}\.js/)
		) {
			logger.debug(`JavaScript request: ${req.method} ${req.path}`);

			// Pre-emptively set the correct MIME type for all JavaScript files
			// This ensures even files served by the static middleware get the right type
			res.setHeader("Content-Type", "application/javascript");
		}

		// Skip if we don't have an agent server or no agents
		if (!server || agents.size === 0) {
			return next();
		}

		// Attempt to match the request with a plugin route
		let handled = false;

		// Check each agent for matching plugin routes
		for (const [, runtime] of agents) {
			if (handled) break;

			// Check each plugin route
			for (const route of runtime.routes) {
				// Skip if method doesn't match
				if (req.method.toLowerCase() !== route.type.toLowerCase()) {
					continue;
				}

				// Check if path matches
				// Make sure we're comparing the path properly
				const routePath = route.path.startsWith("/")
					? route.path
					: `/${route.path}`;
				const reqPath = req.path;

				// Handle exact matches
				if (reqPath === routePath) {
					try {
						route.handler(req, res, runtime);
						handled = true;
						break;
					} catch (error) {
						logger.error("Error handling plugin route", {
							error,
							path: reqPath,
							agent: runtime.agentId,
						});
						res.status(500).json({ error: "Internal Server Error" });
						handled = true;
						break;
					}
				}

				// Handle wildcard paths (e.g., /portal/*)
				if (
					routePath.endsWith("*") &&
					reqPath.startsWith(routePath.slice(0, -1))
				) {
					try {
						// Check if this is likely a static asset request
						const isAssetRequest =
							/\.(js|mjs|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|otf)$/i.test(
								reqPath,
							);

						// For JavaScript module files, handle specially to avoid HTML content
						if (
							reqPath.endsWith(".js") ||
							reqPath.includes(".js?") ||
							reqPath.match(/\/[a-zA-Z0-9_-]+-[A-Za-z0-9]{8}\.js/)
						) {
							// Set JavaScript MIME type
							res.setHeader("Content-Type", "application/javascript");
							res.setHeader("Cache-Control", "no-cache, max-age=0");

							// Try to let the handler serve it
							try {
								route.handler(req, res, runtime);
								handled = true;
								break;
							} catch (jsError) {
								// If file not found or other error, return a JavaScript-formatted 404
								// This ensures browsers don't get HTML content when expecting JS
								logger.debug(
									`JavaScript file not found: ${reqPath} - Using JS-formatted 404`,
								);
								res
									.status(404)
									.send(`// JavaScript module not found: ${reqPath}`);
								handled = true;
								break;
							}
						}

						// For non-JS files, use the normal handler
						route.handler(req, res, runtime);
						handled = true;
						break;
					} catch (error) {
						logger.error("Error handling plugin wildcard route", {
							error,
							path: reqPath,
							agent: runtime.agentId,
						});

						// If the error was from trying to find a static file that doesn't exist,
						// we should continue to next middleware rather than returning a 500
						if (
							error.code === "ENOENT" ||
							error.message?.includes("not found") ||
							error.message?.includes("cannot find")
						) {
							logger.debug(
								`Static file not found: ${reqPath}, continuing to next handler`,
							);
							continue; // Try next route
						}

						// Special handling for module scripts
						if (/\.m?js(\?.*)?$/i.test(reqPath)) {
							logger.debug(
								`Module script error for ${reqPath}, continuing to next handler`,
							);
							continue; // Try next route instead of returning 500
						}

						res.status(500).json({ error: "Internal Server Error" });
						handled = true;
						break;
					}
				}
			}
		}

		// If a plugin route handled the request, stop here
		if (handled) {
			return;
		}

		// Otherwise, continue to the next middleware
		next();
	});

	// Mount sub-routers
	router.use("/agents", agentRouter(agents, server));
	router.use("/tee", teeRouter(agents));

	router.get("/stop", (_req, res) => {
		server.stop();
		res.json({ message: "Server stopping..." });
	});

	// Logs endpoint
	const logsHandler = (req, res) => {
		const since = req.query.since
			? Number(req.query.since)
			: Date.now() - 3600000; // Default 1 hour
		const requestedLevel = (req.query.level?.toString().toLowerCase() ||
			"info") as LogLevel;
		const limit = Math.min(Number(req.query.limit) || 100, 1000); // Max 1000 entries

		// Access the underlying logger instance
		const destination = (logger as unknown)[Symbol.for("pino-destination")];

		if (!destination?.recentLogs) {
			return res.status(500).json({
				error: "Logger destination not available",
				message: "The logger is not configured to maintain recent logs",
			});
		}

		try {
			// Get logs from the destination's buffer
			const recentLogs: LogEntry[] = destination.recentLogs();
			const requestedLevelValue = LOG_LEVELS[requestedLevel] || LOG_LEVELS.info;

			const filtered = recentLogs
				.filter((log) => {
					return log.time >= since && log.level >= requestedLevelValue;
				})
				.slice(-limit);

			res.json({
				logs: filtered,
				count: filtered.length,
				total: recentLogs.length,
				level: requestedLevel,
				levels: Object.keys(LOG_LEVELS),
			});
		} catch (error) {
			res.status(500).json({
				error: "Failed to retrieve logs",
				message: error instanceof Error ? error.message : "Unknown error",
			});
		}
	};

	router.get("/logs", logsHandler);
	router.post("/logs", logsHandler);

	// Health check endpoints
	router.get("/health", (_req, res) => {
		const healthcheck = {
			status: "OK",
			version: process.env.APP_VERSION || "unknown",
			timestamp: new Date().toISOString(),
			dependencies: {
				agents: agents.size > 0 ? "healthy" : "no_agents",
			},
		};

		const statusCode =
			healthcheck.dependencies.agents === "healthy" ? 200 : 503;
		res.status(statusCode).json(healthcheck);
	});

	// Status endpoint
	router.get("/status", (_req, res) => {
		res.json({ status: "ok" });
	});

	return router;
}
