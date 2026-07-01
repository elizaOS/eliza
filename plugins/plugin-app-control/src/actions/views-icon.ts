/**
 * @module plugin-app-control/actions/views-icon
 *
 * icon sub-mode of the VIEWS action.
 *
 * Regenerates a view's self-contained hero/icon directly — no coding agent.
 * Resolves the target view, locates its plugin source, and writes a fresh
 * branded `assets/hero.svg` (served at `/api/views/<id>/hero`). Owner-gated by
 * the VIEWS action like create/edit/delete.
 */

import type {
	ActionResult,
	HandlerCallback,
	IAgentRuntime,
	Memory,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import { readStringOption } from "../params.js";
import type { ViewSummary } from "./views-client.js";
import { resolveTargetView } from "./views-edit.js";
import { writeViewHeroAsset } from "./views-hero.js";
import { isRestrictedPlatform } from "./views-platform.js";
import { locatePluginSourceDir } from "./views-plugin-source.js";

export interface ViewsIconInput {
	runtime: IAgentRuntime;
	message: Memory;
	options?: Record<string, unknown>;
	views: ViewSummary[];
	callback?: HandlerCallback;
	repoRoot: string;
}

const ICON_NOUNS =
	/\b(icons?|images?|heroes?|hero|thumbnails?|pictures?|avatars?|logos?|artworks?|art)\b/gi;
const ICON_VERBS =
	/\b(set|change|update|regenerate|generate|make|create|give|replace|new|redo|refresh|add|render)\b/gi;
const FILLER = new Set([
	"the",
	"a",
	"an",
	"view",
	"views",
	"plugin",
	"plugins",
	"app",
	"for",
	"of",
	"to",
	"on",
	"its",
	"it",
	"my",
	"please",
	"new",
	"with",
	"and",
]);

/**
 * Pull the target view name from explicit options, else from the free text by
 * stripping the icon nouns, mutate verbs, and filler words and keeping the rest
 * (e.g. "regenerate the wallet view icon" → "wallet").
 */
export function extractIconTarget(
	message: Memory,
	options: Record<string, unknown> | undefined,
): string | null {
	const explicit =
		readStringOption(options, "view") ??
		readStringOption(options, "viewId") ??
		readStringOption(options, "id") ??
		readStringOption(options, "name") ??
		readStringOption(options, "target");
	if (explicit) return explicit;

	const text = message.content.text ?? "";
	const stripped = text
		.replace(ICON_NOUNS, " ")
		.replace(ICON_VERBS, " ")
		.replace(/['']s\b/gi, " ");
	const tokens = stripped
		.split(/[^a-z0-9-]+/i)
		.map((token) => token.trim())
		.filter((token) => token.length > 0 && !FILLER.has(token.toLowerCase()));
	const candidate = tokens.join(" ").trim();
	return candidate.length > 0 ? candidate : null;
}

/** Detect whether a request is asking to (re)generate a view's icon/image. */
export function isViewIconRequest(
	text: string,
	options?: Record<string, unknown>,
): boolean {
	const explicit = (
		readStringOption(options, "action") ??
		readStringOption(options, "mode") ??
		""
	)
		.trim()
		.toLowerCase();
	if (explicit === "icon") return true;
	const verbMatch =
		/\b(set|change|update|regenerate|generate|make|create|give|replace|new|redo|refresh|render)\b/i;
	const nounMatch =
		/\b(icon|image|hero|thumbnail|picture|avatar|logo|artwork)\b/i;
	return verbMatch.test(text) && nounMatch.test(text);
}

export async function runViewsIcon({
	message,
	options,
	views,
	callback,
	repoRoot,
}: ViewsIconInput): Promise<ActionResult> {
	if (isRestrictedPlatform()) {
		const text = "Regenerating view icons is not available on this platform.";
		await callback?.({ text });
		return { success: false, text };
	}

	const target = extractIconTarget(message, options);
	if (!target) {
		const text =
			'Which view\'s icon should I regenerate? Try: "regenerate the wallet view icon".';
		await callback?.({ text });
		return { success: false, text };
	}

	const resolution = resolveTargetView(target, views);
	if (resolution.kind === "none") {
		const text = `No view matches "${target}". Try \`action=list\` to see available views.`;
		await callback?.({ text });
		return { success: false, text, data: { target } };
	}
	if (resolution.kind === "ambiguous") {
		const list = resolution.candidates
			.map((view) => `- ${view.label} (${view.id})`)
			.join("\n");
		const text = `"${target}" matches multiple views:\n${list}\nWhich one's icon should I regenerate?`;
		await callback?.({ text });
		return {
			success: false,
			text,
			data: { candidates: resolution.candidates },
		};
	}

	const view = resolution.view;
	const workdir = await locatePluginSourceDir(repoRoot, view);
	if (!workdir) {
		const text = `Could not locate the source directory for ${view.label} (${view.pluginName}); its icon can only be regenerated from a local plugin source.`;
		await callback?.({ text });
		return { success: false, text };
	}

	const result = await writeViewHeroAsset(
		workdir,
		{
			id: view.id,
			label: view.label,
			icon: view.icon,
			tags: view.tags,
		},
		{ overwrite: true },
	);

	const heroUrl = `/api/views/${encodeURIComponent(view.id)}/hero`;
	const text = `Regenerated a fresh branded icon for ${view.label}. It is served at ${heroUrl}.`;
	await callback?.({ text });
	logger.info(
		`[plugin-app-control] VIEWS/icon viewId=${view.id} wrote ${result.absPath}`,
	);

	return {
		success: true,
		text,
		values: { mode: "icon", viewId: view.id, label: view.label },
		data: {
			viewId: view.id,
			heroUrl,
			heroPath: result.absPath,
			suppressActionResultClipboard: true,
		},
	};
}
