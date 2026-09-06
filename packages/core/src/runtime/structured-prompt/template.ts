/** Compiles dynamic prompts and preserves ordered provider segments for cache planning.
 * The compiled-template cache is shared across runtime instances. */
import Handlebars from "handlebars";
import type { PromptSegment } from "../../types/model";
import type { State } from "../../types/state";

const RUNTIME_TEMPLATE_CACHE = new Map<
	string,
	Handlebars.TemplateDelegate<Record<string, unknown>>
>();
const RUNTIME_TEMPLATE_CACHE_LIMIT = 256;
const PROVIDERS_PROMPT_MARKER = "__ELIZA_PROMPT_SEGMENT_PROVIDERS__";
const STABLE_PROMPT_TEMPLATE_KEYS = new Set([
	"agentName",
	"bio",
	"system",
	"topic",
	"topics",
	"adjective",
	"messageDirections",
	"postDirections",
	"directions",
	"examples",
	"characterPostExamples",
	"characterMessageExamples",
	"actionNames",
	"actionsWithDescriptions",
	"providersWithDescriptions",
]);
const STABLE_PROMPT_PROVIDER_NAMES = new Set([
	"ACTIONS",
	"CHARACTER",
	"PROVIDERS",
]);

export function getCompiledRuntimeTemplate(
	template: string,
	alreadyUpgraded = false,
): Handlebars.TemplateDelegate<Record<string, unknown>> {
	const source = alreadyUpgraded ? template : upgradeDoubleToTriple(template);
	const cached = RUNTIME_TEMPLATE_CACHE.get(source);
	if (cached) {
		return cached;
	}

	const compiled = Handlebars.compile(source);
	RUNTIME_TEMPLATE_CACHE.set(source, compiled);
	if (RUNTIME_TEMPLATE_CACHE.size > RUNTIME_TEMPLATE_CACHE_LIMIT) {
		const oldestKey = RUNTIME_TEMPLATE_CACHE.keys().next().value;
		if (typeof oldestKey === "string") {
			RUNTIME_TEMPLATE_CACHE.delete(oldestKey);
		}
	}

	return compiled;
}

export function cleanDynamicPromptTemplateOutput(rawOutput: string): string {
	return rawOutput
		.replace(/<output>[\s\S]*?<\/output>\s*/g, "")
		.replace(/\noutput:\n[\s\S]*$/i, "")
		.replace(/\r\n/g, "\n")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export function extractTemplatePlaceholderKeys(
	templateChunk: string,
): string[] {
	const keys = new Set<string>();
	const PLACEHOLDER_PATTERN = /\{\{\{?\s*([a-zA-Z0-9_.]+)\s*\}?\}\}/g;
	let match = PLACEHOLDER_PATTERN.exec(templateChunk);
	while (match) {
		if (match[1]) {
			keys.add(match[1]);
		}
		match = PLACEHOLDER_PATTERN.exec(templateChunk);
	}
	return [...keys];
}

export function isTemplateChunkStable(templateChunk: string): boolean {
	const placeholderKeys = extractTemplatePlaceholderKeys(templateChunk);
	return placeholderKeys.every(
		(key) => key !== "providers" && STABLE_PROMPT_TEMPLATE_KEYS.has(key),
	);
}

export function getPromptProviderSegments(state: State): PromptSegment[] {
	const providerResults = state.data.providers as
		| Record<string, { text?: string; providerName?: string }>
		| undefined;
	if (!providerResults) {
		return [];
	}

	const providerOrder = Array.isArray(state.data.providerOrder)
		? (state.data.providerOrder as string[])
		: Object.keys(providerResults).sort((left, right) =>
				left.localeCompare(right),
			);

	const segments: PromptSegment[] = [];
	for (const providerName of providerOrder) {
		const result = providerResults[providerName];
		if (!result?.text || result.text.trim() === "") {
			continue;
		}

		if (segments.length > 0) {
			segments.push({ content: "\n", stable: false });
		}

		segments.push({
			content: result.text,
			stable: STABLE_PROMPT_PROVIDER_NAMES.has(providerName),
		});
	}

	return mergePromptSegments(segments);
}

export function renderPromptTemplateSegments(
	templateStr: string,
	context: Record<string, unknown>,
	state: State,
): PromptSegment[] {
	const upgradedTemplate = upgradeDoubleToTriple(templateStr);
	const templateWithMarkers = upgradedTemplate.replace(
		/\{\{\{?\s*providers\s*\}?\}\}/g,
		PROVIDERS_PROMPT_MARKER,
	);
	const templateFunction = getCompiledRuntimeTemplate(
		templateWithMarkers,
		true,
	);
	const renderedWithMarkers = cleanDynamicPromptTemplateOutput(
		templateFunction(context),
	);

	if (
		!templateWithMarkers.includes(PROVIDERS_PROMPT_MARKER) ||
		!renderedWithMarkers.includes(PROVIDERS_PROMPT_MARKER)
	) {
		return [
			{
				content: renderedWithMarkers,
				stable: isTemplateChunkStable(upgradedTemplate),
			},
		];
	}

	const providerSegments = getPromptProviderSegments(state);
	if (providerSegments.length === 0) {
		return [
			{
				content: renderedWithMarkers.replaceAll(
					PROVIDERS_PROMPT_MARKER,
					String(context.providers ?? ""),
				),
				stable: false,
			},
		];
	}

	const templateChunks = templateWithMarkers.split(PROVIDERS_PROMPT_MARKER);
	const renderedChunks = renderedWithMarkers.split(PROVIDERS_PROMPT_MARKER);
	const segments: PromptSegment[] = [];

	for (let i = 0; i < renderedChunks.length; i += 1) {
		const renderedChunk = renderedChunks[i] ?? "";
		if (renderedChunk.length > 0) {
			segments.push({
				content: renderedChunk,
				stable: isTemplateChunkStable(templateChunks[i] ?? ""),
			});
		}

		if (i < renderedChunks.length - 1) {
			segments.push(...providerSegments.map((segment) => ({ ...segment })));
		}
	}

	return mergePromptSegments(segments);
}

export function joinPromptSegmentGroups(
	groups: PromptSegment[][],
): PromptSegment[] {
	const result: PromptSegment[] = [];

	for (const group of groups) {
		const normalized = mergePromptSegments(group);
		if (normalized.length === 0) {
			continue;
		}

		if (result.length > 0) {
			result.push({ content: "\n\n", stable: false });
		}

		result.push(...normalized.map((segment) => ({ ...segment })));
	}

	return result;
}

export function mergePromptSegments(
	segments: PromptSegment[],
): PromptSegment[] {
	const merged: PromptSegment[] = [];

	for (const segment of segments) {
		if (segment.content.length === 0) {
			continue;
		}

		const previous = merged[merged.length - 1];
		if (previous && previous.stable === segment.stable) {
			previous.content += segment.content;
		} else {
			merged.push({ ...segment });
		}
	}

	return merged;
}

export function upgradeDoubleToTriple(tpl: string): string {
	// Pattern breakdown:
	// (?<!\{)      - not preceded by { (avoids matching inside {{{ )
	// \{\{         - match opening {{
	// (?!...)      - not followed by Handlebars special chars: # / ! > { else
	// (\s*)        - capture leading whitespace
	// (\S+?)       - capture variable name (non-greedy, non-whitespace)
	// (\s*)        - capture trailing whitespace
	// \}\}         - match closing }}
	// (?!\})       - not followed by } (avoids matching {{{ }}}
	const DOUBLE_BRACE_VAR =
		/(?<!\{)\{\{(?!#|\/|!|>|\{|else\b)(\s*)(\S+?)(\s*)\}\}(?!\})/g;

	return tpl.replace(DOUBLE_BRACE_VAR, "{{{$1$2$3}}}");
}
