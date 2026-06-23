/**
 * Pre-LLM shortcuts for explicit app/view navigation (#8791).
 *
 * These run only when the core natural-language shortcut gate is enabled
 * (`ELIZA_SHORTCUTS_NL=1`). The default path is unchanged. The target is the
 * existing VIEWS action, which already owns view resolution, loopback navigation,
 * and source-specific validation.
 */

import type { ShortcutDefinition } from "@elizaos/core";

export const VIEW_NAVIGATION_SHORTCUT_ID = "app-control:nl:view-navigation";

const VIEW_SURFACE_PATTERN = [
	"app builder",
	"apps?",
	"automations?",
	"background",
	"browser",
	"calendar",
	"character",
	"chat",
	"companion",
	"contacts?",
	"database",
	"documents?",
	"docs?",
	"email",
	"files?",
	"finances?",
	"focus",
	"goals?",
	"health",
	"inbox",
	"logs?",
	"mail",
	"memories",
	"messages?",
	"notes?",
	"plugins?",
	"portfolio",
	"preferences",
	"relationships?",
	"settings",
	"tasks?",
	"todos?",
	"trajectories",
	"view manager",
	"views?",
	"wallet",
].join("|");

/**
 * One conservative natural shortcut for explicit navigation. It does not try to
 * resolve the final view itself; `VIEWS` does that with the richer
 * `matchViewCommand`/`resolveIntentView` matcher.
 */
export const viewNavigationShortcuts: ShortcutDefinition[] = [
	{
		id: VIEW_NAVIGATION_SHORTCUT_ID,
		kind: "natural",
		patterns: [
			{
				regex: new RegExp(
					`^(?:open|show|go to|navigate to|switch to|launch|display|bring up|pull up|take me to)(?: me)?(?: my| the| app)? (?:${VIEW_SURFACE_PATTERN})(?: view| page| screen| tab| app)?$`,
					"u",
				),
			},
			{
				regex:
					/^(?:check|triage|read|open|show)(?: my| the)? (?:messages|mail|email|inbox)$/u,
			},
			{
				regex:
					/^(?:what(?:s| s| is) on my (?:calendar|agenda|schedule)|am i free)$/u,
			},
			// Common multilingual explicit settings/calendar/message commands that
			// the VIEWS matcher already resolves once the action runs.
			{
				regex:
					/^(?:abre|abrir|muestra|mostrar|mu[eé]strame|ir a|ve a)(?: mis?| la| el| los| las)? (?:ajustes|configuraci[oó]n|calendario|correo|mensajes|billetera|cartera)$/u,
			},
			{
				regex:
					/^(?:ouvre|affiche|montre moi|va (?:a|à))(?: mon| ma| mes| le| la| les)? (?:param[eè]tres|calendrier|messages|courrier|portefeuille)$/u,
			},
			{
				regex:
					/^(?:öffne|oeffne|zeig mir|zeige|geh zu)(?: meine?n?| den| die| das)? (?:einstellungen|kalender|nachrichten|postfach|brieftasche|geldb[oö]rse)$/u,
			},
			{ regex: /^(?:打开|显示)(?:设置|日历|邮件|消息|钱包)$/u },
			{ regex: /^(?:설정|캘린더|메시지|메일|지갑) (?:열어|보여줘)$/u },
			{
				regex:
					/^(?:設定|カレンダー|メール|メッセージ|財布)を?(?:開いて|表示)$/u,
			},
		],
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
