/**
 * Owns Agent Skills startup dependencies and periodic catalog work per runtime.
 * Plugin initialization requires the skills service and publishes slash
 * commands when the optional commands service is present. Disposal only
 * releases periodic work belonging to that runtime.
 */

import type {
	CommandRegistryService,
	IAgentRuntime,
} from "@elizaos/core";
import { ElizaError, Service } from "@elizaos/core";
import { registerLoadedSkillCommands } from "./commands";
import type { AgentSkillsService } from "./services/skills";
import { startSyncTask } from "./tasks/sync-catalog";

const syncTaskCleanupByRuntime = new WeakMap<IAgentRuntime, () => void>();

type SkillsLifecycleService = Pick<
	AgentSkillsService,
	"getCatalogStats" | "getLoadedSkills"
>;
type CommandsService = Pick<CommandRegistryService, "register">;

function isSkillsLifecycleService(
	service: Service,
): service is Service & SkillsLifecycleService {
	return (
		"getLoadedSkills" in service &&
		typeof service.getLoadedSkills === "function" &&
		"getCatalogStats" in service &&
		typeof service.getCatalogStats === "function"
	);
}

function isCommandsService(service: Service): service is Service & CommandsService {
	return "register" in service && typeof service.register === "function";
}

function isMissingCommandsService(error: unknown): boolean {
	return (
		error instanceof Error &&
		error.message === "Service commands not found or failed to start" &&
		!("code" in error)
	);
}

/** Wait for runtime services and activate the runtime-owned plugin work. */
export async function initializeAgentSkillsPlugin(
	runtime: IAgentRuntime,
): Promise<void> {
	const service = await runtime.getServiceLoadPromise("AGENT_SKILLS_SERVICE");
	if (!isSkillsLifecycleService(service)) {
		throw new ElizaError("Agent Skills service has an invalid runtime contract", {
			code: "AGENT_SKILLS_SERVICE_CONTRACT_INVALID",
		});
	}

	let commands: Service | null = null;
	try {
		commands = await runtime.getServiceLoadPromise("commands");
	} catch (error) {
		// error-policy:J4 Slash commands are optional; the skills service and catalog sync remain available.
		if (!isMissingCommandsService(error)) throw error;
		runtime.logger.debug(
			"AgentSkills: Commands service unavailable; skipping slash command registration",
		);
	}
	if (commands && !isCommandsService(commands)) {
		throw new ElizaError("Commands service has an invalid runtime contract", {
			code: "COMMANDS_SERVICE_CONTRACT_INVALID",
		});
	}

	disposeAgentSkillsPlugin(runtime);
	syncTaskCleanupByRuntime.set(runtime, startSyncTask(runtime));

	const registeredCommands = commands
		? registerLoadedSkillCommands(runtime, service, commands)
		: 0;
	const stats = service.getCatalogStats();
	runtime.logger.info(
		`AgentSkills: Ready — ${stats.loaded} skills loaded, ` +
			`${stats.total} in catalog, ${registeredCommands} slash commands ` +
			`(storage: ${stats.storageType})`,
	);
}

/** Release only the periodic work owned by this runtime. */
export function disposeAgentSkillsPlugin(runtime: IAgentRuntime): void {
	const cleanup = syncTaskCleanupByRuntime.get(runtime);
	if (!cleanup) return;
	cleanup();
	syncTaskCleanupByRuntime.delete(runtime);
}

/**
 * Starts plugin work after core's plugin-registration barrier has made every
 * declared service type visible. A plugin `init` hook cannot wait on services:
 * core registers those classes only after the hook returns.
 */
export class AgentSkillsPluginLifecycleService extends Service {
	static serviceType = "AGENT_SKILLS_PLUGIN_LIFECYCLE";
	capabilityDescription =
		"Registers loaded skills as commands and owns periodic catalog refresh";

	static async start(
		runtime: IAgentRuntime,
	): Promise<AgentSkillsPluginLifecycleService> {
		await initializeAgentSkillsPlugin(runtime);
		return new AgentSkillsPluginLifecycleService(runtime);
	}

	async stop(): Promise<void> {
		disposeAgentSkillsPlugin(this.runtime);
	}
}
