import { getBrandConfig } from "./brand-config";

export const PACKAGED_WINDOWS_BOOTSTRAP_PARTITION =
	"persist:bootstrap-isolated";
export const MAC_DESKTOP_CEF_PARTITION = getBrandConfig().cefDesktopPartition;

type Renderer = "native" | "cef";

type BuildInfo = {
	defaultRenderer: Renderer;
	availableRenderers: Renderer[];
};

type MainWindowPartitionOptions = {
	platform?: NodeJS.Platform;
	buildInfo?: BuildInfo;
};

type IsolatedMainViewOptions = {
	platform?: NodeJS.Platform;
	mainWindowPartition: string | null;
	forceMainWindowCef: boolean;
	buildInfo: BuildInfo;
};

function trimToNull(value: string | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed ? trimmed : null;
}

function normalizePersistentPartition(partition: string): string {
	return partition.includes(":") ? partition : `persist:${partition}`;
}

function parseEnabledFlag(value: string | null): boolean {
	if (!value) {
		return false;
	}

	switch (value.toLowerCase()) {
		case "0":
		case "false":
		case "no":
		case "off":
			return false;
		default:
			return true;
	}
}

export function shouldForceMainWindowCef(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): boolean {
	if (platform !== "darwin") {
		return false;
	}

	return parseEnabledFlag(trimToNull(env.ELIZA_DESKTOP_FORCE_CEF));
}

export function shouldUseHeadlessDesktopSmoke(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return parseEnabledFlag(trimToNull(env.ELIZA_DESKTOP_HEADLESS_SMOKE));
}

export function resolveMainWindowPartition(
	env: NodeJS.ProcessEnv = process.env,
	options: MainWindowPartitionOptions = {},
): string | null {
	const platform = options.platform ?? process.platform;
	const explicit = trimToNull(env.ELIZA_DESKTOP_TEST_PARTITION);
	if (explicit) {
		return normalizePersistentPartition(explicit);
	}

	if (trimToNull(env.ELIZA_DESKTOP_TEST_API_BASE)) {
		// The Windows smoke harness redirects APPDATA/LOCALAPPDATA before launch,
		// so the bootstrap renderer can now use a persistent isolated partition.
		return PACKAGED_WINDOWS_BOOTSTRAP_PARTITION;
	}

	if (shouldForceMainWindowCef(env, platform)) {
		return MAC_DESKTOP_CEF_PARTITION;
	}

	if (platform === "linux" && options.buildInfo?.defaultRenderer === "cef") {
		return MAC_DESKTOP_CEF_PARTITION;
	}

	return null;
}

export function shouldUseIsolatedMainView({
	platform = process.platform,
	mainWindowPartition,
	forceMainWindowCef,
	buildInfo,
}: IsolatedMainViewOptions): boolean {
	if (!mainWindowPartition) {
		return false;
	}

	if (platform === "win32") {
		return true;
	}

	return forceMainWindowCef && buildInfo.availableRenderers.includes("cef");
}

export function resolveBootstrapShellRenderer(buildInfo: BuildInfo): Renderer {
	if (buildInfo.availableRenderers.includes("native")) {
		return "native";
	}
	return buildInfo.defaultRenderer;
}

export function resolveBootstrapViewRenderer(buildInfo: BuildInfo): Renderer {
	if (buildInfo.availableRenderers.includes("cef")) {
		return "cef";
	}
	return buildInfo.defaultRenderer;
}
