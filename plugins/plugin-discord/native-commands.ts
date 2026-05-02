import {
	type APIApplicationCommandOption,
	ApplicationCommandOptionType,
	ButtonStyle,
	type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord-api-types/v10";

/**
 * Command argument definition
 */
export interface CommandArgDefinition {
	name: string;
	description: string;
	type: "string" | "number" | "boolean";
	required?: boolean;
	choices?: Array<{ label: string; value: string }>;
}

/**
 * Native command specification
 */
export interface NativeCommandSpec {
	name: string;
	description: string;
	acceptsArgs?: boolean;
	args?: CommandArgDefinition[];
	ephemeralDefault?: boolean;
}

/**
 * Command argument values
 */
export type CommandArgValues = Record<string, string | number | boolean>;

/**
 * Parsed command arguments
 */
export interface CommandArgs {
	values: CommandArgValues;
	raw?: string;
}

/**
 * Result of building command options
 */
export interface BuiltCommandOption {
	name: string;
	description: string;
	type: ApplicationCommandOptionType;
	required?: boolean;
	choices?: Array<{ name: string; value: string | number }>;
}

/**
 * Button specification for argument menus
 */
export interface CommandArgButton {
	label: string;
	customId: string;
	style: ButtonStyle;
}

/**
 * Row of buttons for argument menus
 */
export interface CommandArgButtonRow {
	buttons: CommandArgButton[];
}

/**
 * Argument menu specification
 */
export interface CommandArgMenu {
	content: string;
	rows: CommandArgButtonRow[];
}

/**
 * Key for command argument custom IDs
 */
export const COMMAND_ARG_CUSTOM_ID_KEY = "cmdarg";

/**
 * Builds Discord command options from argument definitions
 */
export function buildDiscordCommandOptions(
	args?: CommandArgDefinition[],
): BuiltCommandOption[] | undefined {
	if (!args || args.length === 0) {
		return undefined;
	}

	return args.map((arg) => {
		const required = arg.required ?? false;

		if (arg.type === "number") {
			return {
				name: arg.name,
				description: arg.description,
				type: ApplicationCommandOptionType.Number,
				required,
			};
		}

		if (arg.type === "boolean") {
			return {
				name: arg.name,
				description: arg.description,
				type: ApplicationCommandOptionType.Boolean,
				required,
			};
		}

		const choices =
			arg.choices && arg.choices.length > 0 && arg.choices.length <= 25
				? arg.choices.map((choice) => ({
						name: choice.label,
						value: choice.value,
					}))
				: undefined;

		return {
			name: arg.name,
			description: arg.description,
			type: ApplicationCommandOptionType.String,
			required,
			choices,
		};
	});
}

/**
 * Builds a complete Discord slash command JSON body
 */
export function buildDiscordSlashCommand(
	spec: NativeCommandSpec,
): RESTPostAPIChatInputApplicationCommandsJSONBody {
	const options = buildDiscordCommandOptions(spec.args);

	const commandOptions: APIApplicationCommandOption[] | undefined =
		options?.map(
			(opt) =>
				({
					name: opt.name,
					description: opt.description,
					type: opt.type,
					required: opt.required,
					choices: opt.choices,
				}) as APIApplicationCommandOption,
		) ??
		(spec.acceptsArgs
			? [
					{
						name: "input",
						description: "Command input",
						type: ApplicationCommandOptionType.String,
						required: false,
					} as APIApplicationCommandOption,
				]
			: undefined);

	return {
		name: spec.name,
		description: spec.description,
		options: commandOptions,
	};
}

/**
 * Encodes a command argument value for use in custom IDs
 */
export function encodeCommandArgValue(value: string): string {
	return encodeURIComponent(value);
}

/**
 * Decodes a command argument value from a custom ID
 */
export function decodeCommandArgValue(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

/**
 * Builds a custom ID for a command argument button
 */
export function buildCommandArgCustomId(params: {
	command: string;
	arg: string;
	value: string;
	userId: string;
}): string {
	return [
		`${COMMAND_ARG_CUSTOM_ID_KEY}:command=${encodeCommandArgValue(params.command)}`,
		`arg=${encodeCommandArgValue(params.arg)}`,
		`value=${encodeCommandArgValue(params.value)}`,
		`user=${encodeCommandArgValue(params.userId)}`,
	].join(";");
}

/**
 * Parses command argument data from a custom ID
 */
export function parseCommandArgCustomId(
	customId: string,
): { command: string; arg: string; value: string; userId: string } | null {
	if (!customId.startsWith(COMMAND_ARG_CUSTOM_ID_KEY)) {
		return null;
	}

	const parts = customId.split(";");
	const data: Record<string, string> = {};

	for (const part of parts) {
		const [key, value] = part.split("=");
		if (key && value) {
			// Handle the first part which has the prefix
			const cleanKey = key.replace(`${COMMAND_ARG_CUSTOM_ID_KEY}:`, "");
			data[cleanKey] = decodeCommandArgValue(value);
		}
	}

	if (!data.command || !data.arg || !data.value || !data.user) {
		return null;
	}

	return {
		command: data.command,
		arg: data.arg,
		value: data.value,
		userId: data.user,
	};
}

/**
 * Chunks an array into smaller arrays of a specified size
 */
function chunkArray<T>(items: T[], size: number): T[][] {
	if (size <= 0) {
		return [items];
	}
	const rows: T[][] = [];
	for (let i = 0; i < items.length; i += size) {
		rows.push(items.slice(i, i + size));
	}
	return rows;
}

/**
 * Builds an argument menu with buttons for command selection
 */
export function buildCommandArgMenu(params: {
	commandName: string;
	arg: CommandArgDefinition;
	choices: Array<{ value: string; label: string }>;
	userId: string;
	title?: string;
	buttonsPerRow?: number;
}): CommandArgMenu {
	const {
		commandName,
		arg,
		choices,
		userId,
		title,
		buttonsPerRow = 4,
	} = params;

	const rows = chunkArray(choices.slice(0, 20), buttonsPerRow).map(
		(rowChoices) => ({
			buttons: rowChoices.map((choice) => ({
				label: choice.label.slice(0, 80),
				customId: buildCommandArgCustomId({
					command: commandName,
					arg: arg.name,
					value: choice.value,
					userId,
				}),
				style: ButtonStyle.Secondary,
			})),
		}),
	);

	const content =
		title ?? `Choose ${arg.description || arg.name} for /${commandName}.`;

	return { content, rows };
}

/**
 * Checks if an error is a Discord "Unknown Interaction" error
 */
export function isUnknownInteractionError(error: unknown): boolean {
	if (!error || typeof error !== "object") {
		return false;
	}

	const err = error as {
		code?: number;
		status?: number;
		message?: string;
		rawError?: { code?: number; message?: string };
	};

	// Discord error code 10062 = Unknown Interaction
	if (err.code === 10062 || err.rawError?.code === 10062) {
		return true;
	}

	if (err.status === 404 && /Unknown interaction/i.test(err.message ?? "")) {
		return true;
	}

	if (/Unknown interaction/i.test(err.rawError?.message ?? "")) {
		return true;
	}

	return false;
}

/**
 * Safely executes a Discord interaction call, catching expired interaction errors
 */
export async function safeInteractionCall<T>(
	fn: () => Promise<T>,
	onExpired?: () => void,
): Promise<T | null> {
	try {
		return await fn();
	} catch (error) {
		if (isUnknownInteractionError(error)) {
			onExpired?.();
			return null;
		}
		throw error;
	}
}

/**
 * Creates command arguments from a single value
 */
export function createCommandArgs(
	argName: string,
	value: string | number | boolean,
): CommandArgs {
	return {
		values: { [argName]: value },
	};
}

/**
 * Serializes command arguments to a string
 */
export function serializeCommandArgs(args?: CommandArgs): string {
	if (!args?.values) {
		return "";
	}

	return Object.entries(args.values)
		.map(([key, value]) => `${key}=${String(value)}`)
		.join(" ");
}

/**
 * Builds the full command text from arguments
 */
export function buildCommandText(
	commandName: string,
	args?: CommandArgs,
): string {
	const argsText = serializeCommandArgs(args);
	return argsText ? `/${commandName} ${argsText}` : `/${commandName}`;
}
