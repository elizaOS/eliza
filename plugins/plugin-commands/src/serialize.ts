/**
 * Canonical command serialization.
 *
 * `serializeCommand` is the single projection from a `CommandDefinition` onto
 * the wire-safe `SerializedCommand` shape every client consumes (web composer,
 * connector bridges). The `GET /api/commands` route is a pure
 * pass-through of this function — it fabricates nothing. This is what closes the
 * "catalog contract dropped at the route" gap (#8790): `surfaces`, auth flags,
 * `category`, real `dynamicChoices`, `icon`, and the full `textAliases` all
 * survive instead of being hardcoded to `false`/`"both"`/`"builtin"`.
 */

import type {
	CommandArgDefinition,
	CommandDefinition,
	CommandSurface,
	SerializedCommand,
	SerializedCommandArg,
	SerializedCommandSource,
} from "./types";

/** Default target when a definition doesn't declare one: run through the agent. */
const DEFAULT_TARGET = { kind: "agent" as const };

/**
 * Whether a command is offered on `surface`. A definition with no `surfaces`
 * is offered everywhere (the default). When `surface` is omitted the command is
 * always included (the catalog query is surface-agnostic).
 */
export function commandVisibleForSurface(
	surfaces: readonly CommandSurface[] | undefined,
	surface: CommandSurface | null | undefined,
): boolean {
	if (!surface) return true;
	if (!surfaces || surfaces.length === 0) return true;
	return surfaces.includes(surface);
}

/** Project a definition's argument onto its wire shape. */
function serializeArg(arg: CommandArgDefinition): SerializedCommandArg {
	const serialized: SerializedCommandArg = {
		name: arg.name,
		description: arg.description,
	};
	if (arg.required) serialized.required = true;
	if (arg.captureRemaining) serialized.captureRemaining = true;
	if (arg.dynamicChoices) serialized.dynamicChoices = arg.dynamicChoices;
	// Function-valued choices need a live provider/model context, so they drop
	// to a dynamic source (if tagged) rather than a fabricated static list.
	if (Array.isArray(arg.choices) && arg.choices.length > 0) {
		serialized.choices = arg.choices;
	}
	return serialized;
}

/**
 * Serialize a `CommandDefinition` onto the canonical `SerializedCommand` wire
 * shape. Every field is read from the definition — nothing is fabricated.
 *
 * @param command the registry definition.
 * @param options.source where the item came from (default `"builtin"`); skills
 *   pass `"custom-action"`/`"saved"` so the menu can group/label them.
 */
export function serializeCommand(
	command: CommandDefinition,
	options: { source?: SerializedCommandSource } = {},
): SerializedCommand {
	const args = (command.args ?? []).map(serializeArg);
	const serialized: SerializedCommand = {
		key: command.key,
		nativeName: command.nativeName ?? command.key,
		description: command.description,
		textAliases: command.textAliases,
		scope: command.scope,
		acceptsArgs: command.acceptsArgs ?? args.length > 0,
		args,
		requiresAuth: command.requiresAuth ?? false,
		requiresElevated: command.requiresElevated ?? false,
		target: command.target ?? DEFAULT_TARGET,
		source: options.source ?? "builtin",
	};
	if (command.category) serialized.category = command.category;
	if (command.surfaces && command.surfaces.length > 0) {
		serialized.surfaces = command.surfaces;
	}
	if (command.icon) serialized.icon = command.icon;
	if (command.views && command.views.length > 0) {
		serialized.views = command.views;
	}
	return serialized;
}
