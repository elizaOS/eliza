import { ComputerSatelliteService } from "../bun/computer-service.ts";
import { ComputerSatelliteException } from "../bun/errors.ts";

const originalScreenshot = process.env.ELIZA_COMPUTER_ENABLE_SCREENSHOT;

try {
	process.env.ELIZA_COMPUTER_ENABLE_SCREENSHOT = "0";
	const service = new ComputerSatelliteService();
	const status = service.status();
	assert(status.id === "eliza.computer", "status returns computer id");
	assert(status.capabilities.displays.available, "displays are available");
	assert(
		!status.capabilities.screenshot.available,
		"screenshot is disabled by default",
	);

	const permissions = service.permissions();
	assert(permissions.screenCapture === "disabled", "screen capture is gated");

	const displays = await service.displays();
	assert(
		displays.displays.length > 0,
		"display snapshot returns at least one display",
	);

	await expectComputerError(
		() => service.screenshot(),
		"COMPUTER_SCREENSHOT_DISABLED",
		"screenshot requires opt-in",
	);

	process.stdout.write(
		`${JSON.stringify(
			{
				ok: true,
				platform: status.platform,
				displaySource: displays.source,
				capabilities: status.capabilities,
			},
			null,
			2,
		)}\n`,
	);
} finally {
	if (originalScreenshot === undefined) {
		delete process.env.ELIZA_COMPUTER_ENABLE_SCREENSHOT;
	} else {
		process.env.ELIZA_COMPUTER_ENABLE_SCREENSHOT = originalScreenshot;
	}
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

async function expectComputerError(
	fn: () => Promise<unknown>,
	code: string,
	message: string,
): Promise<void> {
	try {
		await fn();
	} catch (error) {
		if (error instanceof ComputerSatelliteException && error.code === code)
			return;
		throw error;
	}
	throw new Error(message);
}
