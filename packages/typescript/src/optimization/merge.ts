import type { OptimizedPromptArtifact } from "./types.ts";

/**
 * Merge an optimization artifact into a prompt template string.
 *
 * WHY prepend, not append: LLM providers cache prompt prefixes (KV cache).
 * Optimized content as a fixed prefix maximizes cache hit rates across
 * requests. The base template (with user-specific placeholders) follows,
 * so only the dynamic tail varies between requests.
 *
 * WHY this order: playbook → instructions → demos
 * Playbook rules are the most stable (rarely change between optimization
 * runs), so they anchor the prefix. Demos change most frequently (new
 * examples from recent traces), so they're closest to the dynamic content.
 *
 * WHY bracket markers: `[OPTIMIZED ...]` tags are unambiguous, grep-able,
 * and don't conflict with any prompt template syntax. `stripMergedContent`
 * uses line-bounded regex to reliably remove them without false positives.
 */
export function mergeArtifactIntoPrompt(
	baseTemplate: string,
	artifact: OptimizedPromptArtifact,
): string {
	const sections: string[] = [];

	if (artifact.playbook?.trim()) {
		sections.push(
			`[OPTIMIZED PLAYBOOK]\n${artifact.playbook.trim()}\n[/OPTIMIZED PLAYBOOK]`,
		);
	}

	if (artifact.instructions?.trim()) {
		sections.push(
			`[OPTIMIZED INSTRUCTIONS]\n${artifact.instructions.trim()}\n[/OPTIMIZED INSTRUCTIONS]`,
		);
	}

	if (artifact.demos?.trim()) {
		sections.push(
			`[OPTIMIZED EXAMPLES]\n${artifact.demos.trim()}\n[/OPTIMIZED EXAMPLES]`,
		);
	}

	if (sections.length === 0) {
		return baseTemplate;
	}

	return `${sections.join("\n\n")}\n\n${baseTemplate}`;
}

/**
 * Check if a template string has been merged with optimization content.
 * Useful for debugging.
 */
export function isMergedTemplate(template: string): boolean {
	return (
		template.includes("[OPTIMIZED PLAYBOOK]") ||
		template.includes("[OPTIMIZED INSTRUCTIONS]") ||
		template.includes("[OPTIMIZED EXAMPLES]")
	);
}

/**
 * Strip optimization content from a merged template, restoring the original.
 * Used when we need to re-merge with a newer artifact.
 */
export function stripMergedContent(template: string): string {
	// Match only the exact three marker pairs produced by mergeArtifactIntoPrompt.
	// Each tag must be on its own line (preceded by newline or start-of-string)
	// to avoid false matches on substrings inside user content.
	return template
		.replace(
			/(?:^|\n)\[OPTIMIZED PLAYBOOK\]\n[\s\S]*?\n\[\/OPTIMIZED PLAYBOOK\]\s*/g,
			"",
		)
		.replace(
			/(?:^|\n)\[OPTIMIZED INSTRUCTIONS\]\n[\s\S]*?\n\[\/OPTIMIZED INSTRUCTIONS\]\s*/g,
			"",
		)
		.replace(
			/(?:^|\n)\[OPTIMIZED EXAMPLES\]\n[\s\S]*?\n\[\/OPTIMIZED EXAMPLES\]\s*/g,
			"",
		);
}
