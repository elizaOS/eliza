/**
 * Waits for Agent Skills dependencies and registers loaded skill commands once
 * the runtime's plugin-registration barrier has completed.
 */

import type { CommandRegistryService, IAgentRuntime } from "@elizaos/core";
import { ElizaError, Service } from "@elizaos/core";
import { registerLoadedSkillCommands } from "./commands";
import type { AgentSkillsService } from "./services/skills";

type SkillsLifecycleService = Pick<AgentSkillsService, "getLoadedSkills">;
type CommandsService = Pick<CommandRegistryService, "register">;

function isSkillsLifecycleService(
	service: Service,
): service is Service & SkillsLifecycleService {
	return (
		"getLoadedSkills" in service && typeof service.getLoadedSkills === "function"
	);
}

function isCommandsService(service: Service): service is Service & CommandsService {
	return "register" in service && typeof service.register === "function";
}

/** Wait for required services and activate the runtime-owned plugin work. */
export async function initializeAgentSkillsPlugin(
	runtime: IAgentRuntime,
): Promise<void> {
	const service = await runtime.getServiceLoadPromise("AGENT_SKILLS_SERVICE");
	if (!isSkillsLifecycleService(service)) {
		throw new ElizaError("Agent Skills service has an invalid runtime contract", {
			code: "AGENT_SKILLS_SERVICE_CONTRACT_INVALID",
		});
	}

	let commands: Service;
	try {
		commands = await runtime.getServiceLoadPromise("commands");
	} catch {
		// error-policy:J4 Slash commands are optional; skills remain fully usable.
		runtime.logger.debug(
			"AgentSkills: Commands service unavailable; skipping slash command registration",
		);
		return;
	}
	if (!isCommandsService(commands)) {
		throw new ElizaError("Commands service has an invalid runtime contract", {
			code: "COMMANDS_SERVICE_CONTRACT_INVALID",
		});
	}

	const registeredCommands = registerLoadedSkillCommands(
		runtime,
		service,
		commands,
	);
	runtime.logger.info(
		`AgentSkills: Ready — ${service.getLoadedSkills().length} skills loaded, ${registeredCommands} slash commands`,
	);
}

/** Starts plugin work after all declared service types are visible. */
export class AgentSkillsPluginLifecycleService extends Service {
	static serviceType = "AGENT_SKILLS_PLUGIN_LIFECYCLE";
	capabilityDescription = "Registers loaded skills as commands";

	static async start(
		runtime: IAgentRuntime,
	): Promise<AgentSkillsPluginLifecycleService> {
		await initializeAgentSkillsPlugin(runtime);
		return new AgentSkillsPluginLifecycleService(runtime);
	}

	async stop(): Promise<void> {}
}
