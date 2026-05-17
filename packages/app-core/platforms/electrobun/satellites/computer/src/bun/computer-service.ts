import { mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { throwComputerError } from "./errors.ts";
import type {
	ComputerCapabilityName,
	ComputerCapabilityStatus,
	ComputerDisplay,
	ComputerDisplaysResult,
	ComputerPermissionsResult,
	ComputerScreenshotParams,
	ComputerScreenshotResult,
	ComputerStatusResult,
} from "./protocol.ts";

type CommandResult = {
	ok: boolean;
	stdout: string;
	stderr: string;
	exitCode: number | null;
};

const disabledReason =
	"Screenshot capture requires ELIZA_COMPUTER_ENABLE_SCREENSHOT=1.";

export class ComputerSatelliteService {
	constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

	status(): ComputerStatusResult {
		return {
			id: "eliza.computer",
			ok: true,
			platform: process.platform,
			capabilities: {
				displays: { available: true },
				screenshot: this.screenshotCapability(),
				input: unavailable("Input routing is not wired yet."),
				window: unavailable("Window routing is not wired yet."),
				browser: unavailable("Browser host routing is not wired yet."),
				camera: unavailable("Camera routing is not wired yet."),
				canvas: unavailable("Canvas routing is not wired yet."),
			},
			updatedAt: new Date().toISOString(),
		};
	}

	permissions(): ComputerPermissionsResult {
		const screenshotEnabled = this.env.ELIZA_COMPUTER_ENABLE_SCREENSHOT === "1";
		return {
			screenCapture: screenshotEnabled ? "available" : "disabled",
			input: "unsupported",
			window: "unsupported",
			browser: "unsupported",
			camera: "unsupported",
			canvas: "unsupported",
		};
	}

	async displays(): Promise<ComputerDisplaysResult> {
		if (process.platform === "darwin") {
			const result = await runCommand("system_profiler", [
				"SPDisplaysDataType",
				"-json",
			]);
			if (result.ok) {
				const displays = parseMacDisplays(result.stdout);
				if (displays.length > 0) {
					return { displays, source: "macos-system-profiler" };
				}
			}
		}
		if (process.platform === "linux") {
			const result = await runCommand("xrandr", ["--listmonitors"]);
			if (result.ok) {
				const displays = parseXrandrDisplays(result.stdout);
				if (displays.length > 0) return { displays, source: "xrandr" };
			}
		}
		return {
			displays: [
				{
					id: "primary",
					name: "Primary Display",
					primary: true,
				},
			],
			source: "fallback",
			warning: "Display geometry is unavailable from this host.",
		};
	}

	async screenshot(
		params: ComputerScreenshotParams = {},
	): Promise<ComputerScreenshotResult> {
		if (this.env.ELIZA_COMPUTER_ENABLE_SCREENSHOT !== "1") {
			throwComputerError({
				code: "COMPUTER_SCREENSHOT_DISABLED",
				message: disabledReason,
			});
		}
		if (process.platform !== "darwin" && process.platform !== "linux") {
			throwComputerError({
				code: "COMPUTER_SCREENSHOT_UNSUPPORTED",
				message: `Screenshot capture is not supported on ${process.platform}.`,
			});
		}

		const dir = path.join(os.tmpdir(), `eliza-computer-${crypto.randomUUID()}`);
		const file = path.join(dir, "capture.png");
		await mkdir(dir, { recursive: true });
		try {
			await this.capturePng(file, params);
			const buffer = await readFile(file);
			return {
				mimeType: "image/png",
				base64: buffer.toString("base64"),
				capturedAt: new Date().toISOString(),
				...(params.region === undefined ? {} : { region: params.region }),
			};
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}

	private screenshotCapability(): ComputerCapabilityStatus {
		if (this.env.ELIZA_COMPUTER_ENABLE_SCREENSHOT !== "1") {
			return unavailable(disabledReason);
		}
		if (process.platform === "darwin" || process.platform === "linux") {
			return { available: true };
		}
		return unavailable(
			`Screenshot capture is not supported on ${process.platform}.`,
		);
	}

	private async capturePng(
		file: string,
		params: ComputerScreenshotParams,
	): Promise<void> {
		if (process.platform === "darwin") {
			const args = ["-x", "-t", "png"];
			if (params.region) {
				const region = params.region;
				args.push(
					"-R",
					`${region.x},${region.y},${region.width},${region.height}`,
				);
			}
			args.push(file);
			await expectCommand("screencapture", args);
			return;
		}

		const commands = params.region
			? [
					{
						command: "import",
						args: [
							"-window",
							"root",
							"-crop",
							`${params.region.width}x${params.region.height}+${params.region.x}+${params.region.y}`,
							file,
						],
					},
				]
			: [
					{ command: "gnome-screenshot", args: ["-f", file] },
					{ command: "scrot", args: [file] },
					{ command: "import", args: ["-window", "root", file] },
				];

		for (const command of commands) {
			const result = await runCommand(command.command, command.args);
			if (result.ok) return;
		}

		throwComputerError({
			code: "COMPUTER_SCREENSHOT_UNSUPPORTED",
			message:
				"No supported Linux screenshot command is available. Install gnome-screenshot, scrot, or ImageMagick import.",
		});
	}
}

function unavailable(reason: string): ComputerCapabilityStatus {
	return { available: false, reason };
}

async function expectCommand(command: string, args: string[]): Promise<void> {
	const result = await runCommand(command, args);
	if (!result.ok) {
		throwComputerError({
			code: "COMPUTER_COMMAND_FAILED",
			message: `${command} failed with exit ${result.exitCode ?? "unknown"}.`,
			details: {
				command,
				args,
				stderr: result.stderr,
			},
		});
	}
}

async function runCommand(
	command: string,
	args: string[],
	timeoutMs = 5000,
): Promise<CommandResult> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		const proc = Bun.spawn([command, ...args], {
			stdout: "pipe",
			stderr: "pipe",
		});
		timeout = setTimeout(() => {
			proc.kill();
		}, timeoutMs);
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { ok: exitCode === 0, stdout, stderr, exitCode };
	} catch (error) {
		return {
			ok: false,
			stdout: "",
			stderr: error instanceof Error ? error.message : String(error),
			exitCode: null,
		};
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
	}
}

function parseMacDisplays(stdout: string): ComputerDisplay[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout) as unknown;
	} catch {
		return [];
	}
	if (!isRecord(parsed)) return [];
	const items = parsed.SPDisplaysDataType;
	if (!Array.isArray(items)) return [];
	const displays: ComputerDisplay[] = [];
	for (const item of items) {
		if (!isRecord(item)) continue;
		const displayEntries = item.spdisplays_ndrvs;
		if (!Array.isArray(displayEntries)) continue;
		for (const display of displayEntries) {
			if (!isRecord(display)) continue;
			const name = stringValue(display._name);
			const resolution =
				stringValue(display.spdisplays_resolution) ??
				stringValue(display._spdisplays_resolution) ??
				stringValue(display.spdisplays_pixelresolution);
			displays.push({
				id: name ?? `display-${displays.length}`,
				...(name === undefined ? {} : { name }),
				...parseResolution(resolution),
				primary:
					stringValue(display.spdisplays_main) === "spdisplays_yes" ||
					displays.length === 0,
				raw: display,
			});
		}
	}
	return displays;
}

function parseXrandrDisplays(stdout: string): ComputerDisplay[] {
	const displays: ComputerDisplay[] = [];
	for (const line of stdout.split("\n").slice(1)) {
		const match = line
			.trim()
			.match(
				/^(\d+):\s+([+*]*)(\S+)\s+(\d+)\/\d+x(\d+)\/\d+\+(-?\d+)\+(-?\d+)\s+(.+)$/,
			);
		if (!match) continue;
		displays.push({
			id: match[3] ?? `display-${displays.length}`,
			name: match[8],
			width: Number(match[4]),
			height: Number(match[5]),
			x: Number(match[6]),
			y: Number(match[7]),
			primary: match[2]?.includes("*") === true || displays.length === 0,
			raw: line.trim(),
		});
	}
	return displays;
}

function parseResolution(
	value: string | undefined,
): Pick<ComputerDisplay, "width" | "height"> {
	if (value === undefined) return {};
	const match = value.match(/(\d+)\s*x\s*(\d+)/i);
	if (!match) return {};
	return {
		width: Number(match[1]),
		height: Number(match[2]),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export const computerCapabilityNames: ComputerCapabilityName[] = [
	"displays",
	"screenshot",
	"input",
	"window",
	"browser",
	"camera",
	"canvas",
];
