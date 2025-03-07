import { handleError } from "@/src/utils/handle-error";
import { displayAgent } from "@/src/utils/helpers";
import { logger } from "@/src/utils/logger";
import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import type { Agent } from "@elizaos/core";

const AGENT_RUNTIME_URL =
	process.env.AGENT_RUNTIME_URL?.replace(/\/$/, "") || "http://localhost:3000";
const AGENTS_BASE_URL = `${AGENT_RUNTIME_URL}/agents`;

// Define basic agent interface for type safety
interface AgentBasic {
	id: string;
	name: string;
	status?: string;
	[key: string]: unknown;
}

async function getAgents(): Promise<AgentBasic[]> {
	const response = await fetch(`${AGENTS_BASE_URL}`);
	if (!response.ok) {
		throw new Error(`Failed to fetch agents list: ${response.statusText}`);
	}
	return (
		((await response.json()) as ApiResponse<{ agents: AgentBasic[] }>).data
			?.agents || []
	);
}

// Utility function to resolve agent ID from name, index, or direct ID
async function resolveAgentId(idOrNameOrIndex: string): Promise<string> {
	// First try to get all agents to find by name
	const agents = await getAgents();

	// Try to find agent by name
	const agentByName = agents.find(
		(agent) => agent.name.toLowerCase() === idOrNameOrIndex.toLowerCase(),
	);

	if (agentByName) {
		return agentByName.id;
	}

	// Try to find agent by ID
	const agentById = agents.find((agent) => agent.id === idOrNameOrIndex);

	if (agentById) {
		return agentById.id;
	}

	// Try to find agent by index
	if (!Number.isNaN(Number(idOrNameOrIndex))) {
		return agents[Number(idOrNameOrIndex)].id;
	}

	// If no agent is found, throw an error

	throw new Error(`Agent not found: ${idOrNameOrIndex}`);
}

export const agent = new Command()
	.name("agent")
	.description("manage ElizaOS agents");

interface AgentStartPayload {
	characterPath?: string;
	characterJson?: Record<string, unknown>;
}

interface ApiResponse<T> {
	success: boolean;
	data?: T;
	error?: {
		code: string;
		message: string;
		details?: unknown;
	};
}

interface AgentStartResponse {
	id: string;
	character: Partial<Agent>;
}

agent
	.command("list")
	.alias("ls")
	.description("list available agents")
	.option("-j, --json", "output as JSON")
	.action(async (opts) => {
		try {
			// API Endpoint: GET /agents
			const agents = await getAgents();

			// Format data for table
			const agentData = agents.map((agent) => ({
				Name: agent.name,
				ID: agent.id,
				Status: agent.status || "unknown",
			}));

			if (opts.json) {
				logger.info(JSON.stringify(agentData, null, 2));
			} else {
				logger.info("\nAvailable agents:");
				if (agentData.length === 0) {
					logger.info("No agents found");
				} else {
					console.table(agentData);
				}
			}

			process.exit(0);
		} catch (error) {
			handleError(error);
		}
	});

agent
	.command("get")
	.alias("g")
	.description("get agent details")
	.requiredOption(
		"-n, --name <name>",
		"agent id, name, or index number from list",
	)
	.option("-j, --json", "output as JSON")
	.option("-o, --output <file>", "output to file (default: {name}.json)")
	.action(async (opts) => {
		try {
			const resolvedAgentId = await resolveAgentId(opts.name);

			logger.info(`Getting agent ${resolvedAgentId}`);

			// API Endpoint: GET /agents/:agentId
			const response = await fetch(`${AGENTS_BASE_URL}/${resolvedAgentId}`);
			if (!response.ok) {
				const errorData = (await response.json()) as ApiResponse<unknown>;
				throw new Error(
					errorData.error?.message ||
						`Failed to get agent: ${response.statusText}`,
				);
			}

			const { data: agent } = (await response.json()) as ApiResponse<Agent>;

			// The displayAgent function expects a character object
			displayAgent(agent, "Agent Details");

			// check if json argument is provided
			if (opts.json) {
				const jsonPath =
					opts.output ||
					path.join(process.cwd(), `${agent.name || "agent"}.json`);
				// exclude id and status fields from the json
				const { id, createdAt, updatedAt, enabled, ...agentConfig } = agent;
				fs.writeFileSync(jsonPath, JSON.stringify(agentConfig, null, 2));
				logger.success(`Saved agent configuration to ${jsonPath}`);
			}

			process.exit(0);
		} catch (error) {
			handleError(error);
		}
	});

agent
	.command("start")
	.alias("s")
	.description("start an agent")
	.option("-n, --name <name>", "character name to start the agent with")
	.option("-j, --json <json>", "character JSON string")
	.option("-p, --path <path>", "local path to character JSON file")
	.option("-r, --remote <url>", "remote URL to character JSON file")
	.action(async (opts) => {
		try {
			// API Endpoint: POST /agents
			const response: Response = await (async () => {
				const payload: AgentStartPayload = {};
				const headers = { "Content-Type": "application/json" };

				// Determine which start option to use
				const startOption = opts.json
					? "json"
					: opts.remote
						? "remote"
						: opts.path
							? "path"
							: opts.name
								? "name"
								: "none";

				switch (startOption) {
					case "json":
						try {
							payload.characterJson = JSON.parse(opts.json);
							return await fetch(`${AGENTS_BASE_URL}`, {
								method: "POST",
								headers,
								body: JSON.stringify(payload),
							});
						} catch (error) {
							throw new Error(`Failed to parse JSON string: ${error.message}`);
						}

					case "remote":
						if (
							!opts.remote.startsWith("http://") &&
							!opts.remote.startsWith("https://")
						) {
							throw new Error("Remote URL must start with http:// or https://");
						}
						payload.characterPath = opts.remote;
						return await fetch(`${AGENTS_BASE_URL}`, {
							method: "POST",
							headers,
							body: JSON.stringify(payload),
						});

					case "path":
						try {
							const fileContent = fs.readFileSync(opts.path, "utf8");
							payload.characterJson = JSON.parse(fileContent);
							return await fetch(`${AGENTS_BASE_URL}`, {
								method: "POST",
								headers,
								body: JSON.stringify(payload),
							});
						} catch (error) {
							throw new Error(
								`Failed to read or parse local JSON file: ${error.message}`,
							);
						}

					case "name": {
						const agentId = await resolveAgentId(opts.name);
						try {
							return await fetch(`${AGENTS_BASE_URL}/${agentId}`, {
								method: "POST",
								headers,
								body: JSON.stringify(payload),
							});
						} catch (error) {
							throw new Error(
								`Failed to start agent by name: ${error.message}`,
							);
						}
					}

					default:
						throw new Error(
							"Please provide either a character name, path to JSON file, remote URL, or character JSON string",
						);
				}
			})();

			if (!response.ok) {
				const errorData = (await response.json()) as ApiResponse<unknown>;
				throw new Error(
					errorData.error?.message ||
						`Failed to start agent: ${response.statusText}`,
				);
			}

			const data = (await response.json()) as ApiResponse<AgentStartResponse>;
			const result = data.data;

			if (!result) {
				throw new Error("Failed to start agent: No data returned from server");
			}

			logger.success(
				`Successfully started agent ${result.character.name} (${result.id})`,
			);
		} catch (error) {
			handleError(error);
		}
	});

agent
	.command("stop")
	.alias("st")
	.description("stop an agent")
	.requiredOption(
		"-n, --name <name>",
		"agent id, name, or index number from list",
	)
	.action(async (opts) => {
		try {
			const resolvedAgentId = await resolveAgentId(opts.name);

			logger.info(`Stopping agent ${resolvedAgentId}`);

			// API Endpoint: PUT /agents/:agentId
			const response = await fetch(`${AGENTS_BASE_URL}/${resolvedAgentId}`, {
				method: "PUT",
			});

			if (!response.ok) {
				const errorData = (await response.json()) as ApiResponse<unknown>;
				throw new Error(
					errorData.error?.message ||
						`Failed to stop agent: ${response.statusText}`,
				);
			}

			logger.success(`Successfully stopped agent ${opts.name}`);
		} catch (error) {
			handleError(error);
		}
	});

agent
	.command("remove")
	.alias("rm")
	.description("remove an agent")
	.requiredOption(
		"-n, --name <name>",
		"agent id, name, or index number from list",
	)
	.action(async (opts) => {
		try {
			const resolvedAgentId = await resolveAgentId(opts.name);

			logger.info(`Removing agent ${resolvedAgentId}`);

			// API Endpoint: DELETE /agents/:agentId
			const response = await fetch(`${AGENTS_BASE_URL}/${resolvedAgentId}`, {
				method: "DELETE",
			});

			if (!response.ok) {
				const errorData = (await response.json()) as ApiResponse<unknown>;
				throw new Error(
					errorData.error?.message ||
						`Failed to remove agent: ${response.statusText}`,
				);
			}

			// Server returns 204 No Content for successful deletion, no need to parse response
			logger.success(`Successfully removed agent ${opts.name}`);
		} catch (error) {
			handleError(error);
		}
	});

agent
	.command("set")
	.description("update agent configuration")
	.requiredOption(
		"-n, --name <name>",
		"agent id, name, or index number from list",
	)
	.option("-c, --config <json>", "configuration as JSON string")
	.option("-f, --file <path>", "path to configuration JSON file")
	.action(async (opts) => {
		try {
			const resolvedAgentId = await resolveAgentId(opts.name);

			logger.info(`Updating configuration for agent ${resolvedAgentId}`);

			let config: Record<string, unknown>;
			if (opts.config) {
				try {
					config = JSON.parse(opts.config);
				} catch (error) {
					throw new Error(
						`Failed to parse config JSON string: ${error.message}`,
					);
				}
			} else if (opts.file) {
				try {
					config = JSON.parse(fs.readFileSync(opts.file, "utf8"));
				} catch (error) {
					throw new Error(
						`Failed to read or parse config file: ${error.message}`,
					);
				}
			} else {
				throw new Error(
					"Please provide either a config JSON string (-c) or a config file path (-f)",
				);
			}

			// API Endpoint: PATCH /agents/:agentId
			const response = await fetch(`${AGENTS_BASE_URL}/${resolvedAgentId}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ updates: config }),
			});

			if (!response.ok) {
				const errorData = (await response.json()) as ApiResponse<unknown>;
				throw new Error(
					errorData.error?.message ||
						`Failed to update agent configuration: ${response.statusText}`,
				);
			}

			const data = (await response.json()) as ApiResponse<{ id: string }>;
			const result = data.data;

			logger.success(
				`Successfully updated configuration for agent ${result?.id || resolvedAgentId}`,
			);
		} catch (error) {
			handleError(error);
		}
	});
