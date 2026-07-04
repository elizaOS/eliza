/**
 * CommandRegistryService — the runtime seam for the chat-command registry.
 *
 * Registered by this plugin under service type `"commands"`. Hosts and other
 * plugins contribute commands through
 * `runtime.getService<CommandRegistryService>("commands")` instead of importing
 * this package, so registrations always land on the loaded plugin instance's
 * per-runtime store (no module-duplication drift) and never reset commands
 * registered by earlier plugins.
 */

import {
	type CommandDefinition,
	CommandRegistryService as CommandRegistryServiceContract,
	type IAgentRuntime,
} from "@elizaos/core";
import {
	getCommandsForRuntime,
	registerCommandForRuntime,
} from "./registry.js";

export class CommandRegistryService extends CommandRegistryServiceContract {
	static override readonly serviceType = "commands";
	override capabilityDescription =
		"Chat-command registry: register and read slash/native commands per runtime.";

	static override async start(
		runtime: IAgentRuntime,
	): Promise<CommandRegistryService> {
		return new CommandRegistryService(runtime);
	}

	async stop(): Promise<void> {}

	override register(command: CommandDefinition): void {
		registerCommandForRuntime(this.runtime.agentId, command);
	}

	override list(): CommandDefinition[] {
		return getCommandsForRuntime(this.runtime.agentId);
	}
}
