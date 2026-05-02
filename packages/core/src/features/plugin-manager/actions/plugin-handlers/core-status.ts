/**
 * @module features/plugin-manager/actions/plugin-handlers/core-status
 *
 * `core_status` sub-mode of the unified PLUGIN action. Reports whether
 * `@elizaos/core` is currently ejected or running from the npm package.
 */

import type {
	ActionResult,
	HandlerCallback,
} from "../../../../types/components.ts";
import type { IAgentRuntime } from "../../../../types/runtime.ts";
import type {
	CoreManagerService,
	CoreStatus,
} from "../../services/coreManagerService.ts";

export interface CoreStatusInput {
	runtime: IAgentRuntime;
	callback?: HandlerCallback;
}

export async function runCoreStatus({
	runtime,
	callback,
}: CoreStatusInput): Promise<ActionResult> {
	const service = runtime.getService(
		"core_manager",
	) as CoreManagerService | null;
	if (!service) {
		const text = "Core manager service not available";
		await callback?.({ text });
		return { success: false, text };
	}

	const status: CoreStatus = await service.getCoreStatus();

	const lines: string[] = [];
	if (status.ejected) {
		lines.push(`Core is EJECTED at ${status.ejectedPath}`);
		lines.push(`Version: ${status.version}`);
		lines.push(`Commit: ${status.commitHash || "unknown"}`);
		lines.push(`Local changes: ${status.localChanges ? "yes" : "no"}`);
		if (status.upstream) {
			lines.push(
				`Upstream: ${status.upstream.gitUrl}#${status.upstream.branch}`,
			);
			lines.push(`Last sync: ${status.upstream.lastSyncAt || "never"}`);
		}
	} else {
		lines.push(
			`Core is using NPM package (v${status.npmVersion}). Not ejected.`,
		);
	}

	const text = lines.join("\n");
	await callback?.({ text });
	return {
		success: true,
		text,
		values: { mode: "core_status", ejected: status.ejected },
		data: {
			ejected: status.ejected,
			ejectedPath: status.ejectedPath,
			monorepoPath: status.monorepoPath,
			corePackagePath: status.corePackagePath,
			coreDistPath: status.coreDistPath,
			version: status.version,
			npmVersion: status.npmVersion,
			commitHash: status.commitHash ?? undefined,
			localChanges: status.localChanges,
			upstream: status.upstream ?? undefined,
		},
	};
}
