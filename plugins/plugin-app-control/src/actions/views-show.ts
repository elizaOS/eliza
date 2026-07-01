/**
 * @module plugin-app-control/actions/views-show
 *
 * show/open sub-mode: resolve a view by name or ID and navigate to it.
 *
 * Navigation uses POST /api/apps/launch with the view's shell path as the
 * target. When the view has no `path`, the agent tells the user the view
 * ID and how to navigate manually.
 */

import type {
	ActionResult,
	HandlerCallback,
	Memory,
	ViewType,
} from "@elizaos/core";
import {
	getUserMessageText,
	logger,
	resolveServerOnlyPort,
} from "@elizaos/core";
import { resolveSettingsSectionToken } from "@elizaos/ui/components/settings/settings-section-tokens";
import { markViewSwitch } from "../runtime/view-switch-signal.js";
import { matchViewCommand } from "./view-command-matcher.js";
import type { ViewSummary, ViewsClient } from "./views-client.js";
import { scoreView } from "./views-search.js";

const SHOW_VERBS = [
	"show",
	"open",
	"navigate to",
	"go to",
	"switch to",
	"view",
	"launch",
	"display",
	"bring up",
	"pull up",
];

const FILLER_WORDS = new Set([
	"the",
	"view",
	"app",
	"page",
	"please",
	"pls",
	"now",
	"my",
	"me",
	"us",
	"a",
	"an",
]);

const DOCUMENT_SURFACE_WORDS =
	/\b(?:documents?|docs?|files?|knowledge|uploads?|retrieval|papers?)\b/i;
const NOTES_SURFACE_WORD = /\bnotes?\b/i;

// Match a show-verb on WORD BOUNDARIES at the earliest position in the text.
// Anchoring with \b stops the bare verb "view" from firing inside words like
// "overview"/"preview"/"review"/"interview" (which an unanchored indexOf scan
// did, mis-parsing "give me an overview of my wallet"). Longest-first so a
// multi-word verb ("navigate to") wins over any shorter prefix.
const SHOW_VERB_PATTERN = new RegExp(
	`\\b(?:${[...SHOW_VERBS]
		.sort((a, b) => b.length - a.length)
		.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.join("|")})\\b`,
	"i",
);

export function isStandaloneNotesSurfaceRequest(text: string): boolean {
	return NOTES_SURFACE_WORD.test(text) && !DOCUMENT_SURFACE_WORDS.test(text);
}

function extractViewTarget(
	message: Memory | undefined,
	options: Record<string, unknown> | undefined,
): string | null {
	// Explicit option wins. Accept every alias the VIEWS schema + the other
	// sub-modes accept (view/viewId/id/target/name) so a planner-supplied
	// `{ action: "show", target: "settings" }` or `{ viewId: "settings" }`
	// resolves instead of dead-ending on the text scan.
	const explicit =
		readStringOpt(options, "view") ??
		readStringOpt(options, "viewId") ??
		readStringOpt(options, "id") ??
		readStringOpt(options, "target") ??
		readStringOpt(options, "name");
	if (explicit) return explicit;

	const text = getUserMessageText(message);

	const match = SHOW_VERB_PATTERN.exec(text);
	if (match) {
		const rest = text.slice(match.index + match[0].length).trim();
		if (rest) {
			const tokens = rest
				.split(/[\s,!.?]+/)
				.map((t) => t.trim())
				.filter((t) => t.length > 0);
			// Strip filler from both ends: "the wallet view" / "wallet page" /
			// "settings view please" should all resolve to the bare view name.
			let start = 0;
			while (
				start < tokens.length &&
				FILLER_WORDS.has(tokens[start].toLowerCase())
			) {
				start++;
			}
			let end = tokens.length;
			while (end > start && FILLER_WORDS.has(tokens[end - 1].toLowerCase())) {
				end--;
			}
			const candidate = tokens.slice(start, end).join(" ").toLowerCase();
			if (candidate && !FILLER_WORDS.has(candidate)) return candidate;
		}
	}

	return null;
}

function readStringOpt(
	options: Record<string, unknown> | undefined,
	key: string,
): string | null {
	if (!options) return null;
	const v = options[key];
	if (typeof v !== "string") return null;
	const t = v.trim();
	return t.length > 0 ? t : null;
}

// Deterministic intent -> view safety net. Passive utterances ("what's on my
// calendar", "I want to add a new feature to my app") carry no explicit view
// name, so the verb scan + keyword scorer return nothing. These rules map a
// recognized DOMAIN intent straight to a concrete view id. Kept deliberately
// specific (anchored on "my <surface>" / explicit intent phrases) so it only
// fires as a fallback once a normal target resolution has already failed — it
// never overrides an explicit navigation. Owner-decided mappings: "messages"
// and "email" both route to the cross-channel inbox; app/feature/coding intent
// routes to the task-coordinator (coding-agent) view.
const INTENT_VIEW_RULES: ReadonlyArray<{ re: RegExp; viewId: string }> = [
	{
		re: /\b(add (a |an )?(new )?feature|build (me )?(an? )?(new )?app|app builder|work on my app|coding view|code something|write some code|ship (a |an )?feature)\b/i,
		viewId: "task-coordinator",
	},
	{
		re: /\b(what'?s on my (calendar|agenda|schedule)|what is on my (calendar|agenda|schedule)|my (calendar|agenda|schedule)|my next (meeting|event|appointment)|am i free)\b/i,
		viewId: "calendar",
	},
	{
		re: /\b(check (my )?messages|my messages|my (e-?mail|inbox|mail)|check my (e-?mail|inbox|mail)|any new (e-?mail|messages|mail)|triage my inbox)\b/i,
		viewId: "inbox",
	},
	{
		re: /\b(my wallet|my balance|my portfolio|my crypto|my funds|my tokens|my holdings)\b/i,
		viewId: "wallet",
	},
	{
		re: /\b(my finances|my spending|my money|my budget|my transactions|my bank|how much (did|have) i (spend|spent)|recurring charges|my subscriptions)\b/i,
		viewId: "finances",
	},
	{
		re: /\b(i need to focus|help me focus|focus mode|block (out )?distractions|stop distractions|deep work)\b/i,
		viewId: "focus",
	},
	{
		re: /\b(my goals|my routines|my reminders|my alarms|my habits)\b/i,
		viewId: "goals",
	},
	{
		re: /\b(my health|my sleep|my screen ?time|my activity|my steps|my workouts?|how did i sleep)\b/i,
		viewId: "health",
	},
	{
		re: /\b(my (to-?dos?|tasks|task list|checklist)|what('?s| is) on my (to-?do|task) list|things to do)\b/i,
		viewId: "todos",
	},
	{
		re: /\b(my (documents?|files?|papers?)|my docs|pull up (the |my )?(documents?|files?))\b/i,
		viewId: "documents",
	},
	{
		re: /\b(my (contacts?|relationships?|people|network|address book)|who do i know|my rolodex)\b/i,
		viewId: "relationships",
	},
	{
		re: /\b(my (settings|preferences)|(change|update|edit|open|go to|show|take me to) (my |the |app )?(settings|preferences|configuration)|app settings|settings (page|screen|menu)|configure (the )?app)\b/i,
		viewId: "settings",
	},
	// --- Multilingual deterministic rules ---
	// Eliza is local-first; a small/local model may not reliably route a
	// non-English navigation request, so the deterministic safety net handles the
	// common surfaces in major languages too. Anchored on a possessive
	// (mi/mon/mein/我的/내) or a navigation verb (muéstrame/montre-moi/zeig/打开/
	// 보여줘/열어) immediately around a surface noun, so they only fire on genuine
	// navigation intent. Match against the lowercased message.
	{
		re: /(?:mi|mon|mein|我的|내\s?)\s*(?:calendario|calendrier|kalender|日历|カレンダー|캘린더|agenda)|(?:mu[eé]strame|montre-moi|zeig mir|打开|显示|보여줘|열어)[\s\S]{0,12}(?:calendario|calendrier|kalender|日历|캘린더)/i,
		viewId: "calendar",
	},
	{
		re: /(?:mi|mis|mon|mes|mein|meine|我的|내\s?)\s*(?:correo|bandeja|mensajes|courrier|messages|nachrichten|postfach|邮件|消息|메시지|메일)|(?:mu[eé]strame|montre-moi|zeig mir|打开|显示|보여줘|열어)[\s\S]{0,12}(?:correo|mensajes|messages|nachrichten|邮件|메시지)/i,
		viewId: "inbox",
	},
	{
		re: /(?:mi|mis|mon|mes|mein|meine|我的|내\s?)\s*(?:cartera|billetera|portefeuille|brieftasche|geldb[oö]rse|钱包|지갑|wallet)/i,
		viewId: "wallet",
	},
	{
		re: /(?:mis|mes|meine|我的)\s*(?:finanzas|gastos|finances|d[eé]penses|finanzen|财务|花费|开销)|(?:cu[aá]nto (?:gast[eé]|he gastado)|combien (?:j'ai d[eé]pens[eé]))/i,
		viewId: "finances",
	},
	{
		re: /(?:mis|mes|meine|我的|내\s?)\s*(?:metas|objetivos|objectifs|ziele|目标|목표|routines?|rutinas)/i,
		viewId: "goals",
	},
	{
		re: /(?:mi|ma|mein|meine|我的|내\s?)\s*(?:salud|sue[nñ]o|sant[eé]|sommeil|gesundheit|健康|睡眠|건강)/i,
		viewId: "health",
	},
	{
		re: /(?:mis|mes|meine|我的|내\s?)\s*(?:tareas|pendientes|t[aâ]ches|aufgaben|待办|任务|할\s?일|todos?)/i,
		viewId: "todos",
	},
	{
		re: /(?:mis|mes|meine|我的|내\s?)\s*(?:documentos|archivos|documents|fichiers|dokumente|dateien|文档|文件|문서)/i,
		viewId: "documents",
	},
	{
		re: /(?:mis|mes|meine|我的|내\s?)\s*(?:contactos|contacts|kontakte|联系人|연락처|relaciones|relations)/i,
		viewId: "relationships",
	},
	{
		re: /(?:concentrarme|necesito concentrarme|me concentrer|konzentrieren|专注|集中|집중)|modo (?:enfoque|concentraci[oó]n)|mode concentration/i,
		viewId: "focus",
	},
];

/**
 * All view ids any `INTENT_VIEW_RULES` rule can resolve to. Exported for the
 * cross-list drift guard (#8797) so a passive intent can never target a view the
 * matcher cannot also reach by explicit command.
 */
export const INTENT_VIEW_IDS: readonly string[] = [
	...new Set(INTENT_VIEW_RULES.map((rule) => rule.viewId)),
];

/**
 * Map a passive domain intent to a concrete view id, or null when no rule
 * matches. Used both as a `runViewsShow` fallback (when normal resolution
 * fails) and by `inferMode` to route intent-only utterances to `show`.
 *
 * #10471 boundary — RETAINED, INTENTIONAL FAST-PATH ALLOW-LIST (not a smell).
 * This deterministic matcher is deliberately kept out of the string-smell
 * cleanup for three reasons, documented here as the required written
 * justification:
 *   1. It is *multilingual by construction* — `matchViewCommand` covers explicit
 *      "open X" navigation in every language, and `INTENT_VIEW_RULES` carries
 *      parallel English + ES/FR/DE/ZH/JA/KO rules — so it is the opposite of the
 *      i18n-hostile English-only matching #10471 targets.
 *   2. It is a *fallback that never decides against the model*: it fires only
 *      after normal id/label/fuzzy resolution returns nothing, and never
 *      overrides an explicit navigation the planner already produced.
 *   3. Eliza is local-first; a small/on-device planner cannot be relied on to
 *      route navigation across languages, so this pre-LLM safety net is a
 *      correctness requirement, not a shortcut. Removing it would regress
 *      weak-local-model multilingual navigation.
 * Keep the rules anchored on a possessive / navigation verb around a surface
 * noun (as below) so they only fire on genuine navigation intent.
 */
export function resolveIntentView(text: string | undefined): string | null {
	const t = (text ?? "").toLowerCase();
	if (!t) return null;
	// Fast rigid multilingual matcher first (every explicit "open X" phrasing in
	// every language); fall back to the legacy intent rules for the few passive
	// phrasings it intentionally does not cover (e.g. "am i free" → calendar).
	const rigid = matchViewCommand(text);
	if (rigid) return rigid;
	for (const rule of INTENT_VIEW_RULES) {
		if (rule.re.test(t)) return rule.viewId;
	}
	return null;
}

function resolveView(
	target: string,
	views: readonly ViewSummary[],
):
	| { kind: "match"; view: ViewSummary }
	| { kind: "ambiguous"; candidates: ViewSummary[] }
	| { kind: "none" } {
	const q = target.toLowerCase();

	// Exact id match.
	const byId = views.find((v) => v.id.toLowerCase() === q);
	if (byId) return { kind: "match", view: byId };

	// Exact label match.
	const byLabel = views.find((v) => v.label.toLowerCase() === q);
	if (byLabel) return { kind: "match", view: byLabel };

	// Scored fuzzy — reuse search scoring.
	const scored = views
		.map((v) => ({ view: v, score: scoreView(v, target) }))
		.filter(({ score }) => score > 0)
		.sort((a, b) => b.score - a.score);

	if (scored.length === 0) return { kind: "none" };
	if (scored.length === 1) return { kind: "match", view: scored[0].view };

	// Top-score tie-break: single winner if top score is strictly higher.
	const topScore = scored[0].score;
	const topTied = scored.filter(({ score }) => score === topScore);
	if (topTied.length === 1) return { kind: "match", view: topTied[0].view };

	return { kind: "ambiguous", candidates: topTied.map(({ view }) => view) };
}

function resolveRegisteredNotesView(
	views: readonly ViewSummary[],
):
	| { kind: "match"; view: ViewSummary }
	| { kind: "ambiguous"; candidates: ViewSummary[] }
	| { kind: "none" } {
	const resolution = resolveView("notes", views);
	if (resolution.kind !== "match") return resolution;
	return resolution.view.id === "documents" ? { kind: "none" } : resolution;
}

interface NavigateResult {
	ok: boolean;
	text: string;
	/** Resolved sub-section the renderer was asked to focus (settings only). */
	subview?: string;
}

/**
 * Resolve a caller-supplied sub-section token into the value the renderer
 * focuses. Settings is the only view with addressable sub-sections today, so we
 * reuse the canonical client token→section-id map (`resolveSettingsSectionToken`)
 * rather than inventing a second mapping. An unknown token for the settings view
 * (or any token for another view) is passed through verbatim — the renderer
 * applies the same resolution and ignores values it doesn't recognize.
 */
function resolveSubviewForView(
	view: ViewSummary,
	subview: string | undefined,
): string | undefined {
	const token = subview?.trim();
	if (!token) return undefined;
	if (view.id === "settings") {
		return resolveSettingsSectionToken(token) ?? token.toLowerCase();
	}
	return token;
}

async function navigateToView(
	view: ViewSummary,
	requestedViewType?: ViewType,
	subview?: string,
): Promise<NavigateResult> {
	// Emit navigate event via POST /api/views/:id/navigate (shell listens).
	// A 501/404 means this shell doesn't implement the navigate route — opening
	// the view still counts as a soft success (the user can click through). A
	// real transport failure (other non-2xx, network, timeout) is NOT success:
	// reporting "Switched to X" when nothing happened misleads the user and the
	// chain's verifiedUserFacing logic.
	const port = resolveServerOnlyPort(process.env);
	const base = `http://127.0.0.1:${port}`;
	const resolvedSubview = resolveSubviewForView(view, subview);

	try {
		const resp = await fetch(
			`${base}/api/views/${encodeURIComponent(view.id)}/navigate${requestedViewType ? `?viewType=${requestedViewType}` : ""}`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					path: view.path,
					viewType: requestedViewType,
					...(resolvedSubview ? { subview: resolvedSubview } : {}),
				}),
				signal: AbortSignal.timeout(5_000),
			},
		);
		const sectionSuffix = resolvedSubview ? ` → ${resolvedSubview}` : "";
		if (resp.ok)
			return {
				ok: true,
				text: `Navigated to ${view.label}${sectionSuffix} (${view.viewType ?? "gui"}).`,
				subview: resolvedSubview,
			};
		// 501/404 = navigation route unsupported by this shell; opening succeeds.
		if (resp.status === 501 || resp.status === 404)
			return {
				ok: true,
				text: `Opened ${view.label}${sectionSuffix}.`,
				subview: resolvedSubview,
			};

		const body = await resp.text().catch(() => "");
		logger.warn(
			`[plugin-app-control] VIEWS/show navigate returned ${resp.status}: ${body}`,
		);
	} catch (err) {
		logger.warn(
			`[plugin-app-control] VIEWS/show navigate failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	const pathHint = view.path ? ` at ${view.path}` : "";
	return {
		ok: false,
		text: `Couldn't switch to ${view.label}${pathHint} — the shell did not confirm the change.`,
	};
}

export interface RunViewsShowInput {
	client: ViewsClient;
	message: Memory;
	options?: Record<string, unknown>;
	viewType?: ViewType;
	callback?: HandlerCallback;
}

export async function runViewsShow({
	client,
	message,
	options,
	viewType,
	callback,
}: RunViewsShowInput): Promise<ActionResult> {
	const messageText = getUserMessageText(message);
	// Passive intent ("what's on my calendar", "muéstrame mi calendario") carries
	// no explicit view name, so the verb scan yields nothing — the domain intent
	// supplies the view id. Either source is enough to proceed.
	const intentViewId = resolveIntentView(messageText);
	let target = extractViewTarget(message, options) ?? intentViewId;
	if (!target) {
		const text =
			'Tell me which view to open. Try: "open wallet" or "show settings".';
		await callback?.({ text });
		return { success: false, text };
	}

	const views = await client.listViews({ viewType });
	let resolution = resolveView(target, views);
	if (
		isStandaloneNotesSurfaceRequest(messageText) &&
		resolution.kind === "match" &&
		resolution.view.id === "documents"
	) {
		target = "notes";
		resolution = resolveRegisteredNotesView(views);
	}

	// The user's own words are authoritative: when the message names a known
	// domain surface, prefer that deterministic intent view over a (possibly
	// hallucinated) model-supplied `view` param — but ONLY when the intent view
	// is actually registered in this deployment. A weak/local planner emitting
	// view:"wallet" for "open my calendar" is corrected here; an intent that maps
	// to a surface this build doesn't have (e.g. task-coordinator without the
	// coding plugin loaded) leaves the planner's explicit, registered target in
	// place. So the model never needs to correctly GUESS the surface.
	if (intentViewId && intentViewId !== target) {
		const intentResolution = resolveView(intentViewId, views);
		const intentRegistered =
			intentResolution.kind !== "none" && intentResolution.kind !== "ambiguous";
		if (intentRegistered || resolution.kind === "none") {
			resolution = intentResolution;
			target = intentViewId;
		}
	}

	if (resolution.kind === "none") {
		const text = `No view matches "${target}". Try \`action=list\` to see available views.`;
		await callback?.({ text });
		return { success: false, text, data: { target } };
	}

	if (resolution.kind === "ambiguous") {
		const candidates = resolution.candidates;
		const list = candidates.map((v) => `- ${v.label} (${v.id})`).join("\n");
		const text = `"${target}" matches multiple views:\n${list}\nWhich one did you mean?`;
		await callback?.({ text });
		return { success: false, text, data: { candidates } };
	}

	const view = resolution.view;
	const subview =
		readStringOpt(options, "subview") ?? readStringOpt(options, "section");
	const result = await navigateToView(view, viewType, subview ?? undefined);

	// Record the switch so the compose hook injects the acknowledgement provider
	// (and the provider phrases it) on this turn's reply and the immediate next.
	if (result.ok) markViewSwitch(message?.roomId);

	logger.info(
		`[plugin-app-control] VIEWS/show viewId=${view.id} viewType=${view.viewType ?? "gui"}${result.subview ? ` subview=${result.subview}` : ""}`,
	);
	await callback?.({ text: result.text });
	return {
		success: result.ok,
		text: result.text,
		values: {
			mode: "show",
			viewId: view.id,
			viewType: view.viewType ?? viewType ?? "gui",
			label: view.label,
			...(result.subview ? { subview: result.subview } : {}),
		},
		data: { view, ...(result.subview ? { subview: result.subview } : {}) },
	};
}
