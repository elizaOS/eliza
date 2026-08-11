/**
 * Owns Agent Skills startup dependencies and periodic catalog work per runtime.
 * Plugin initialization waits for both required services before exposing skill
 * commands, while disposal only releases work belonging to that runtime.
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

	disposeAgentSkillsPlugin(runtime);
	syncTaskCleanupByRuntime.set(runtime, startSyncTask(runtime));

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
