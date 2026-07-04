/**
 * OpenXR runtime detection + install planning — the desktop half of WebXR.
 *
 * WebKitGTK (Linux Electrobun) and Chromium (Windows WebView2) ship the WebXR
 * Device API, but `navigator.xr` only resolves a headset when an **OpenXR
 * runtime** (Monado / SteamVR / Windows Mixed Reality) is installed and marked
 * active. This module answers "is a runtime present?" and, if not, produces an
 * ordered, platform-specific install plan the {@link facewear} setup script,
 * route, and action all render.
 *
 * Detection follows the OpenXR loader's own resolution order (active_runtime.json
 * via env → XDG/user → system on Linux; the `HKLM\SOFTWARE\Khronos\OpenXR\1`
 * registry value on Windows). All filesystem/registry access goes through an
 * injectable {@link RuntimeProbe} so the logic is unit-testable against fixtures.
 */

export type DesktopPlatform = "linux" | "win32" | "darwin";

export type OpenXrRuntimeName =
	| "monado"
	| "steamvr"
	| "wmr"
	| "oculus"
	| "unknown";

export interface OpenXrRuntimeStatus {
	platform: string;
	/** A usable OpenXR runtime is active (active_runtime resolvable to a real lib). */
	installed: boolean;
	/** Best-effort identification of the active runtime. */
	runtime: OpenXrRuntimeName | null;
	/** The active_runtime.json the loader will use, if found. */
	activeRuntimePath: string | null;
	/** The runtime library the active_runtime.json points at, if resolvable. */
	libraryPath: string | null;
	/** How the active runtime was located (env / xdg / system / registry). */
	source: string | null;
	/**
	 * True when WebXR can in principle reach a headset on this platform once a
	 * runtime is present — i.e. the browser engine ships the WebXR Device API.
	 * (Linux WebKitGTK ✓, Windows Chromium ✓; macOS WebXR is native/visionOS-only.)
	 */
	webxrReady: boolean;
	notes: string[];
}

export interface OpenXrInstallStep {
	id: string;
	title: string;
	description: string;
	/** A shell command the user (or installer) can run. */
	command?: string;
	/** A download / instructions URL. */
	url?: string;
	/** True when the step needs admin/root — an installer must not run it silently. */
	privileged: boolean;
}

export interface OpenXrInstallPlan {
	platform: string;
	/** The runtime the plan targets. */
	runtime: OpenXrRuntimeName;
	/** Nothing to do — a runtime is already active. */
	satisfied: boolean;
	steps: OpenXrInstallStep[];
}

/** Injectable system access so detection is testable against fixtures. */
export interface RuntimeProbe {
	platform: () => string;
	env: (key: string) => string | undefined;
	homedir: () => string;
	fileExists: (path: string) => boolean;
	readFile: (path: string) => string | null;
	/** Resolve a command on PATH, or null. */
	which: (cmd: string) => string | null;
	/** Windows registry read: returns the value's data, or null. */
	regQuery?: (key: string, value: string) => string | null;
}

/** SteamVR's Steam app id — `steam steam://install/250820` installs it. */
const STEAMVR_APP_ID = "250820";

// ── Detection ─────────────────────────────────────────────────────────────────

/** Resolve the active OpenXR runtime for the current platform. */
export function detectOpenXrRuntime(probe: RuntimeProbe): OpenXrRuntimeStatus {
	const plat = probe.platform();
	if (plat === "linux") return detectLinux(probe);
	if (plat === "win32") return detectWindows(probe);
	if (plat === "darwin") return detectDarwin(probe);
	return {
		platform: plat,
		installed: false,
		runtime: null,
		activeRuntimePath: null,
		libraryPath: null,
		source: null,
		webxrReady: false,
		notes: [`OpenXR runtime detection is not supported on '${plat}'.`],
	};
}

function detectLinux(probe: RuntimeProbe): OpenXrRuntimeStatus {
	const xdg = probe.env("XDG_CONFIG_HOME") || join(probe.homedir(), ".config");
	// OpenXR loader's active_runtime.json resolution order.
	const candidates: { path: string; source: string }[] = [];
	const envOverride = probe.env("XR_RUNTIME_JSON");
	if (envOverride)
		candidates.push({ path: envOverride, source: "XR_RUNTIME_JSON" });
	candidates.push(
		{ path: join(xdg, "openxr/1/active_runtime.json"), source: "xdg-user" },
		{ path: "/etc/xdg/openxr/1/active_runtime.json", source: "xdg-system" },
		{
			path: "/usr/local/share/openxr/1/active_runtime.json",
			source: "usr-local",
		},
		{ path: "/usr/share/openxr/1/active_runtime.json", source: "usr-share" },
	);

	const notes: string[] = [];
	for (const c of candidates) {
		if (!probe.fileExists(c.path)) continue;
		const parsed = parseActiveRuntime(probe.readFile(c.path));
		if (!parsed) {
			notes.push(`Found ${c.path} but could not parse its runtime entry.`);
			continue;
		}
		const libExists = libraryExists(probe, parsed.libraryPath);
		if (!libExists) {
			notes.push(
				`Active runtime ${c.path} points at a missing library (${parsed.libraryPath}); it is stale.`,
			);
			continue;
		}
		return {
			platform: "linux",
			installed: true,
			runtime: identifyRuntime(parsed.libraryPath, parsed.name),
			activeRuntimePath: c.path,
			libraryPath: parsed.libraryPath,
			source: c.source,
			webxrReady: true,
			notes,
		};
	}

	// No active runtime — is a runtime at least installed but not selected?
	if (probe.which("monado-service")) {
		notes.push(
			"Monado is installed (monado-service on PATH) but no active_runtime.json selects it.",
		);
	}
	return {
		platform: "linux",
		installed: false,
		runtime: null,
		activeRuntimePath: null,
		libraryPath: null,
		source: null,
		webxrReady: true, // WebKitGTK ships WebXR; it just needs a runtime.
		notes,
	};
}

function detectWindows(probe: RuntimeProbe): OpenXrRuntimeStatus {
	const notes: string[] = [];
	const envOverride = probe.env("XR_RUNTIME_JSON");
	const active =
		envOverride ??
		probe.regQuery?.("HKLM\\SOFTWARE\\Khronos\\OpenXR\\1", "ActiveRuntime") ??
		null;
	if (active && probe.fileExists(active)) {
		const parsed = parseActiveRuntime(probe.readFile(active));
		return {
			platform: "win32",
			installed: true,
			runtime: parsed
				? identifyRuntime(parsed.libraryPath, parsed.name)
				: "unknown",
			activeRuntimePath: active,
			libraryPath: parsed?.libraryPath ?? null,
			source: envOverride ? "XR_RUNTIME_JSON" : "registry",
			webxrReady: true,
			notes,
		};
	}
	if (active) notes.push(`Registry ActiveRuntime points at missing ${active}.`);
	return {
		platform: "win32",
		installed: false,
		runtime: null,
		activeRuntimePath: null,
		libraryPath: null,
		source: null,
		webxrReady: true, // WebView2/Chromium ships WebXR; it just needs a runtime.
		notes,
	};
}

function detectDarwin(probe: RuntimeProbe): OpenXrRuntimeStatus {
	void probe;
	return {
		platform: "darwin",
		installed: false,
		runtime: null,
		activeRuntimePath: null,
		libraryPath: null,
		source: null,
		// macOS/visionOS WebXR is native (ARKit via WKWebView/Safari), not OpenXR.
		webxrReady: false,
		notes: [
			"macOS uses native WebXR on visionOS Safari; there is no OpenXR runtime to install.",
		],
	};
}

// ── Install planning (pure) ───────────────────────────────────────────────────

/** Build the platform-specific steps to get an OpenXR runtime active. */
export function planOpenXrInstall(
	status: OpenXrRuntimeStatus,
): OpenXrInstallPlan {
	if (status.installed) {
		return {
			platform: status.platform,
			runtime: status.runtime ?? "unknown",
			satisfied: true,
			steps: [],
		};
	}
	if (status.platform === "linux") return linuxPlan();
	if (status.platform === "win32") return windowsPlan();
	return {
		platform: status.platform,
		runtime: "unknown",
		satisfied: status.platform === "darwin", // nothing to install on macOS
		steps: [],
	};
}

function linuxPlan(): OpenXrInstallPlan {
	return {
		platform: "linux",
		runtime: "monado",
		satisfied: false,
		steps: [
			{
				id: "steamvr",
				title: "Install SteamVR (no root, easiest with a Steam library)",
				description:
					"If you already use Steam, SteamVR registers a system OpenXR runtime with no admin rights.",
				command: `steam steam://install/${STEAMVR_APP_ID}`,
				url: "https://store.steampowered.com/app/250820/SteamVR/",
				privileged: false,
			},
			{
				id: "monado-apt",
				title: "Install Monado (open-source OpenXR runtime)",
				description:
					"Monado is the reference open-source runtime. On Debian/Ubuntu install the loader + runtime, then it auto-registers as the active runtime.",
				command:
					"sudo apt-get install -y libopenxr-loader1 libopenxr1-monado monado",
				url: "https://monado.freedesktop.org/getting-started.html",
				privileged: true,
			},
			{
				id: "monado-activate",
				title: "Start the Monado service",
				description:
					"Run the Monado compositor so WebXR sessions have a runtime to bind. Keep it running while you use the headset.",
				command: "monado-service",
				privileged: false,
			},
		],
	};
}

function windowsPlan(): OpenXrInstallPlan {
	return {
		platform: "win32",
		runtime: "steamvr",
		satisfied: false,
		steps: [
			{
				id: "steamvr",
				title: "Install SteamVR (recommended OpenXR runtime)",
				description:
					"SteamVR provides an OpenXR runtime for most PC headsets and sets itself active.",
				command: `steam steam://install/${STEAMVR_APP_ID}`,
				url: "https://store.steampowered.com/app/250820/SteamVR/",
				privileged: false,
			},
			{
				id: "wmr",
				title: "Or use Windows Mixed Reality / the OpenXR Tools",
				description:
					"For WMR headsets, install 'OpenXR Tools for Windows Mixed Reality' from the Microsoft Store and set the active runtime there.",
				url: "https://apps.microsoft.com/detail/9n5cvvl23qbt",
				privileged: false,
			},
		],
	};
}

// ── helpers ───────────────────────────────────────────────────────────────────

interface ActiveRuntimeEntry {
	libraryPath: string;
	name?: string;
}

/** Parse an active_runtime.json into its library path + optional name. */
export function parseActiveRuntime(
	json: string | null,
): ActiveRuntimeEntry | null {
	if (!json) return null;
	let data: unknown;
	try {
		data = JSON.parse(json);
	} catch {
		return null;
	}
	const runtime = (data as { runtime?: unknown }).runtime;
	if (!runtime || typeof runtime !== "object") return null;
	const lib = (runtime as { library_path?: unknown }).library_path;
	if (typeof lib !== "string" || lib.length === 0) return null;
	const name = (runtime as { name?: unknown }).name;
	return {
		libraryPath: lib,
		name: typeof name === "string" ? name : undefined,
	};
}

/** Map a runtime library path / name to a known runtime id. */
export function identifyRuntime(
	libraryPath: string,
	name?: string,
): OpenXrRuntimeName {
	const hay = `${libraryPath} ${name ?? ""}`.toLowerCase();
	if (hay.includes("monado")) return "monado";
	if (hay.includes("steamvr") || hay.includes("steamxr")) return "steamvr";
	if (hay.includes("mixedreality") || hay.includes("wmr")) return "wmr";
	if (hay.includes("oculus") || hay.includes("oxr_meta")) return "oculus";
	return "unknown";
}

/**
 * Whether a runtime library_path resolves. The loader accepts an absolute path
 * or a bare soname it resolves via the dynamic linker; we can only verify the
 * former by hand, so a relative soname is treated as present (the linker owns it).
 */
function libraryExists(probe: RuntimeProbe, libraryPath: string): boolean {
	if (!libraryPath.startsWith("/")) return true; // soname → trust the linker
	return probe.fileExists(libraryPath);
}

function join(...parts: string[]): string {
	return parts
		.map((p, i) =>
			i === 0 ? p.replace(/\/+$/, "") : p.replace(/^\/+|\/+$/g, ""),
		)
		.filter((p) => p.length > 0)
		.join("/");
}
