export {
	compileTemplate,
	matchShortcut,
	normalizeForMatch,
	SHORTCUT_AMBIGUITY_EPSILON,
	SHORTCUT_CONFIDENCE_FLOOR,
	ShortcutRegistry,
} from "./runtime/shortcut-registry";
export type {
	ShortcutDefinition,
	ShortcutKind,
	ShortcutMatch,
	ShortcutMatchContext,
	ShortcutPattern,
	ShortcutTarget,
} from "./types/shortcut";
