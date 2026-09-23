/**
 * Settings sections — the canonical destinations the `/settings <section>`
 * command can open in the Eliza app.
 *
 * Each section has a stable `id` (the canonical token connectors advertise and
 * the app routes on), a human `label`, and optional `aliases` that map common
 * synonyms onto the canonical id. `resolveSettingsSection` turns any raw token
 * (id or alias) into its canonical id.
 */

export interface SettingsSection {
	/** Canonical, stable section id used for routing and as the choice token. */
	id: string;
	/** Human-readable label for display. */
	label: string;
	/** Alternate tokens that resolve to this section. */
	aliases?: string[];
}

const SETTINGS_SECTIONS: ReadonlyArray<SettingsSection> = [
	{
		id: "ai-model",
		label: "AI Model & Providers",
		aliases: ["model", "models", "providers", "provider", "llm"],
	},
	{ id: "general", label: "General", aliases: ["basics"] },
	{ id: "agent", label: "Agent", aliases: ["character", "persona"] },
	{ id: "voice", label: "Voice", aliases: ["audio", "tts", "speech"] },
	{ id: "connectors", label: "Connectors", aliases: ["integrations"] },
	{ id: "skills", label: "Skills" },
	{ id: "memory", label: "Memory", aliases: ["knowledge"] },
	{ id: "permissions", label: "Permissions", aliases: ["security", "access"] },
	{ id: "billing", label: "Billing", aliases: ["plan", "subscription"] },
	{ id: "appearance", label: "Appearance", aliases: ["theme", "display"] },
	{ id: "notifications", label: "Notifications", aliases: ["alerts"] },
	{ id: "advanced", label: "Advanced", aliases: ["developer", "debug"] },
];

/** Lazily-built lookup from id/alias → canonical section. */
let lookup: Map<string, SettingsSection> | null = null;

function getLookup(): Map<string, SettingsSection> {
	if (lookup) return lookup;
	const map = new Map<string, SettingsSection>();
	for (const section of SETTINGS_SECTIONS) {
		map.set(section.id, section);
		for (const alias of section.aliases ?? []) {
			map.set(alias, section);
		}
	}
	lookup = map;
	return map;
}

/** All canonical section ids, in declaration order. */
export function getSettingsSections(): SettingsSection[] {
	return [...SETTINGS_SECTIONS];
}

/**
 * Canonical section ids, usable directly as connector option choices.
 *
 * Returns ids only (not aliases) so the choice list stays small and stable; the
 * count is well under Discord's 25-choice cap.
 */
export function getSettingsSectionChoices(): string[] {
	return SETTINGS_SECTIONS.map((section) => section.id);
}

/**
 * Resolve a raw `/settings` section token (canonical id or alias) to its
 * canonical section id. Returns `undefined` when the token matches nothing.
 */
export function resolveSettingsSection(raw: string): string | undefined {
	const normalized = raw.trim().toLowerCase();
	if (!normalized) return undefined;
	return getLookup().get(normalized)?.id;
}
