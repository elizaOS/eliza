/**
 * Natural-language pre-LLM shortcuts for explicit view navigation (#8791).
 *
 * These are intentionally narrow: they only match direct navigation phrases
 * such as "open settings" or "show me my calendar". The global runtime flag
 * (`ELIZA_SHORTCUTS_NL=1`) still controls whether natural shortcuts can fire.
 */

import type { ShortcutDefinition } from "@elizaos/core";

export const VIEW_NAVIGATION_SHORTCUT_ID = "app-control:nl:view-navigation";

const NAVIGATION_REGEX =
	/^(?:(?:open|show|go to|switch to|take me to|pull up|bring up|check|view)\s+(?:me\s+)?(?:my\s+|the\s+)?(?<view>settings|calendar|agenda|schedule|inbox|messages|wallet|app builder|task coordinator)|what(?:s| s| is)\s+on\s+my\s+(?<calendar>calendar|agenda|schedule)|abre\s+(?<settingsEs>ajustes|configuracion|configuración)|打开(?<settingsZh>设置)|設定を開いて|설정\s*(?:열어|열어줘))$/u;

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
