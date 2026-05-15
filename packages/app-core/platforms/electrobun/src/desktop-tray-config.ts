function parseTruthy(value: string | undefined): boolean {
	const normalized = value?.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes";
}

function parseFalsy(value: string | undefined): boolean {
	const normalized = value?.trim().toLowerCase();
	return normalized === "0" || normalized === "false" || normalized === "no";
}

export function shouldCreateDesktopTray(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	if (parseTruthy(env.ELIZA_DESKTOP_DISABLE_TRAY)) {
		return false;
	}

	if (parseFalsy(env.ELIZA_DESKTOP_TRAY)) {
		return false;
	}

	return true;
}
