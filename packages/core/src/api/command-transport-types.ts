/** Wire contract for GET /api/commands. Domain command types remain separate from their serialized transport representation. */

import type {
	CommandArgSource,
	CommandCategory,
	CommandScope,
	CommandSurface,
	CommandTarget,
} from "../types/commands.js";

export type {
	ClientCommandAction,
	CommandArgSource,
	CommandCategory,
	CommandScope,
	CommandSurface,
	CommandTarget,
} from "../types/commands.js";

/**
 * Wire-safe argument shape produced by `serializeCommand`. Static `choices` are
 * inlined; `dynamicChoices` names a live source the client resolves at render
 * time (function-valued definition choices drop to their tagged source).
 */
export interface SerializedCommandArg {
	name: string;
	description: string;
	required?: boolean;
	choices?: string[];
	dynamicChoices?: CommandArgSource;
	captureRemaining?: boolean;
}

/** Where a serialized catalog item came from — drives menu grouping/labels. */
export type SerializedCommandSource = "builtin" | "custom-action" | "saved";

/**
 * The wire shape `GET /api/commands` serves and every client renders. Produced
 * by the command-service serializer with no field fabricated at
 * the HTTP boundary. `target` is the `@elizaos/core` `CommandTarget` discriminant
 * every surface routes on.
 */
export interface SerializedCommand {
	key: string;
	nativeName: string;
	description: string;
	textAliases: string[];
	scope: CommandScope;
	category?: CommandCategory;
	acceptsArgs: boolean;
	args: SerializedCommandArg[];
	requiresAuth: boolean;
	requiresElevated: boolean;
	surfaces?: CommandSurface[];
	target: CommandTarget;
	icon?: string;
	source: SerializedCommandSource;
	/** View ids this command is scoped to; omitted when global. */
	views?: string[];
}

/** Response body of `GET /api/commands`. */
export interface CommandsCatalogResponse {
	commands: SerializedCommand[];
	surface: string | null;
	activeViewId?: string | null;
	agentId: string | null;
	generatedAt: string;
}
