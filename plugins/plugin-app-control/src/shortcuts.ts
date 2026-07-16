/**
 * Natural-language pre-LLM shortcuts for explicit view navigation (#8791).
 *
 * These are intentionally narrow: they only match direct navigation phrases
 * such as "open settings" or "show me my calendar"; the runtime's confidence
 * floor and ambiguity checks decide whether they can fire.
 */

import type { ShortcutDefinition } from "@elizaos/core";

const VIEW_TARGET_PATTERN =
	"settings|calendar|agenda|schedule|inbox|messages|mailbox|mail|email|e-mail|emails|wallet|app builder|task coordinator|home|home screen|home page|home dashboard|dashboard|main screen|main page|main chat|chat";
const NAVIGATION_VERB_PATTERN =
	"open|show|go(?: back)?(?: to)?|back(?: to)?|return(?: to)?|switch to|take me to|pull up|bring up|check|view";

export const VIEW_NAVIGATION_SHORTCUT_ID = "app-control:nl:view-navigation";

const NAVIGATION_REGEX = new RegExp(
	`^(?:(?:${NAVIGATION_VERB_PATTERN})\\s+(?:me\\s+)?(?:my\\s+|the\\s+)?(?<surface>${VIEW_TARGET_PATTERN})|what(?:s| s| is)\\s+on\\s+my\\s+(?<calendar>calendar|agenda|schedule)|abre\\s+(?<settingsEs>ajustes|configuracion|configuración)|打开(?<settingsZh>设置)|設定を開いて|설정\\s*(?:열어|열어줘))$`,
	"u",
);

export const viewNavigationShortcuts: ShortcutDefinition[] = [
	{
		id: VIEW_NAVIGATION_SHORTCUT_ID,
		kind: "natural",
		patterns: [{ regex: NAVIGATION_REGEX }],
		target: {
			kind: "action",
			name: "VIEWS",
			parameters: { action: "show" },
		},
		requiresAction: "VIEWS",
		confidence: 0.94,
		priority: 25,
	},
];
