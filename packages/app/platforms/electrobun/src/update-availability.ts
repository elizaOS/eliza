import path from "node:path";

export type DesktopUpdateBuildVariant = "direct" | "store";

export interface DesktopUpdateAvailabilityInput {
	platform: NodeJS.Platform;
	execPath: string;
	homeDir: string;
	appName: string;
	buildVariant: DesktopUpdateBuildVariant;
}

export interface DesktopUpdateAvailability {
	appBundlePath: string | null;
	canAutoUpdate: boolean;
	autoUpdateDisabledReason: string | null;
}

export function resolveMacAppBundlePath(execPath: string): string | null {
	let current = path.resolve(execPath);
	while (true) {
		if (current.endsWith(".app")) return current;
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

export function resolveDesktopUpdateAvailability(
	input: DesktopUpdateAvailabilityInput,
): DesktopUpdateAvailability {
	if (input.buildVariant === "store") {
		return {
			appBundlePath:
				input.platform === "darwin"
					? resolveMacAppBundlePath(input.execPath)
					: null,
			canAutoUpdate: false,
			autoUpdateDisabledReason: `${input.appName} updates are managed by the app store for this build.`,
		};
	}

	if (input.platform !== "darwin") {
		return {
			appBundlePath: null,
			canAutoUpdate: true,
			autoUpdateDisabledReason: null,
		};
	}

	const appBundlePath = resolveMacAppBundlePath(input.execPath);
	if (!appBundlePath) {
		return {
			appBundlePath: null,
			canAutoUpdate: false,
			autoUpdateDisabledReason: `${input.appName} must run from an installed .app bundle to enable in-place updates.`,
		};
	}

	const supportedRoots = [
		"/Applications",
		path.join(input.homeDir, "Applications"),
	].map((root) => path.resolve(root));
	const normalizedBundlePath = path.resolve(appBundlePath);
	const inApplications = supportedRoots.some((root) => {
		const normalizedRoot = root.endsWith(path.sep)
			? root
			: `${root}${path.sep}`;
		return (
			normalizedBundlePath === root ||
			normalizedBundlePath.startsWith(normalizedRoot)
		);
	});

	if (inApplications) {
		return {
			appBundlePath: normalizedBundlePath,
			canAutoUpdate: true,
			autoUpdateDisabledReason: null,
		};
	}

	return {
		appBundlePath: normalizedBundlePath,
		canAutoUpdate: false,
		autoUpdateDisabledReason: `Move ${path.basename(
			normalizedBundlePath,
		)} to /Applications to enable in-place desktop updates.`,
	};
}
