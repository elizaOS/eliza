import prompts from "prompts";
import { logger } from "./logger";

export const NAV_BACK = "__back__";
export const NAV_NEXT = "__next__";

export async function promptWithNav(
	label: string,
	initial = "",
	validate?: (val: string) => true | string,
): Promise<string> {
	const msg = `${label}${initial ? ` (current: ${initial})` : ""}`;
	const res = await prompts({
		type: "text",
		name: "value",
		message: msg,
		initial,
		validate,
	});
	const input = res.value !== undefined ? res.value.trim() : "";
	if (input.toLowerCase() === "cancel") return "cancel";
	if (input.toLowerCase() === "back") return NAV_BACK;
	if (input.toLowerCase() === "quit" || input.toLowerCase() === "exit") {
		logger.info("Exiting...");
		process.exit(0);
	}
	if (input === "" && initial) return initial; // Return initial if empty and exists
	if (input === "" || input.toLowerCase() === "next") return NAV_NEXT;
	return input;
}

export async function promptForMultipleItems(
	fieldName: string,
	initial: string[] = [],
): Promise<string[]> {
	const items = [...initial];
	logger.info(`\n${fieldName}`);
	if (initial.length > 0) {
		logger.info("Current values:");
		initial.forEach((item, i) => logger.info(`  ${i + 1}. ${item}`));
		logger.info(
			"\nPress Enter to keep existing values, or start typing new ones:",
		);
	}

	while (true) {
		const val = await promptWithNav(`> ${fieldName}:`);
		if (val === NAV_NEXT) break;
		if (val === NAV_BACK) {
			if (items.length === initial.length) return initial; // Return original if no change
			break;
		}
		if (val === "cancel") return initial;
		items.push(val);
	}
	return items;
}

export async function confirmAction(message: string): Promise<boolean> {
	const response = await prompts({
		type: "confirm",
		name: "confirm",
		message,
		initial: false,
	});
	return Boolean(response.confirm);
}
