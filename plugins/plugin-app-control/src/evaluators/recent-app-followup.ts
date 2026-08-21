/** Keep short visual/open follow-ups attached to the most recent local app. */

import type {
	Memory,
	ResponseHandlerEvaluator,
	ResponseHandlerEvaluatorContext,
} from "@elizaos/core";
import { userRequestMessageText } from "../params.js";

const APP_ACTION_NAME = "APP";
const GENERAL_CONTEXT = "general";
const LOCAL_APP_LINK =
	/\[Open\s+([^\]\n]+)\]\((?:https?:\/\/[^/)\s]+)?\/api\/apps\/local\/([A-Za-z0-9._~%-]+)\/?\)/iu;
const OPEN_RECENT_APP =
	/^\s*(?:please\s+)?(?:open|launch|show)(?:\s+me)?\s+(?:it|that\s+app|the\s+app)(?:\s+(?:again|now|please))?[.!?]*\s*$/iu;
const VISUAL_EDIT_VERB = /\b(?:change|edit|m(?:a)?ke|set|turn|update)\b/iu;
const VISUAL_EDIT_TARGET =
	/(?:#[0-9a-f]{3,8}\b|\b(?:background|black|blue|brown|button|cyan|dark|darker|font|gray|green|grey|heading|layout|light|lighter|magenta|navy|orange|page|pink|purple|red|site|spacing|teal|text|title|transparent|white|yellow)\b)/iu;
const EXPLICIT_ELIZA_SURFACE =
	/\b(?:eliza(?:'s)?|home\s+(?:background|screen)|chat\s+background|interface|ui|wallpaper|backdrop)\b/iu;

type RecentLocalApp = {
	displayName: string;
	slug: string;
};

type RecentAppFollowup =
	| { kind: "launch"; app: RecentLocalApp; text: string }
	| { kind: "edit"; app: RecentLocalApp; text: string };

function hasRegisteredAppAction(
	context: ResponseHandlerEvaluatorContext,
): boolean {
	return (context.runtime.actions ?? []).some(
		(action) => action.name?.toUpperCase() === APP_ACTION_NAME,
	);
}

function structuredRecentMessages(
	context: ResponseHandlerEvaluatorContext,
): Memory[] {
	const providers = context.state.data?.providers;
	if (!providers || typeof providers !== "object") return [];
	const recent = (providers as Record<string, unknown>).RECENT_MESSAGES;
	if (!recent || typeof recent !== "object") return [];
	const data = (recent as { data?: unknown }).data;
	const messages =
		data && typeof data === "object" && "recentMessages" in data
			? (data as { recentMessages?: unknown }).recentMessages
			: undefined;
	if (!Array.isArray(messages)) return [];
	return messages.filter(
		(message): message is Memory =>
			Boolean(message) && typeof message === "object",
	);
}

function findRecentLocalApp(
	context: ResponseHandlerEvaluatorContext,
): RecentLocalApp | null {
	return (
		structuredRecentMessages(context)
			.filter(
				(memory) =>
					memory.id !== context.message.id &&
					memory.entityId === context.runtime.agentId &&
					typeof memory.content?.text === "string",
			)
			.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
			.slice(0, 12)
			.flatMap((memory) => {
				const text = memory.content.text;
				if (typeof text !== "string") return [];
				const match = text.match(LOCAL_APP_LINK);
				if (!match) return [];
				return [{ displayName: match[1].trim(), slug: match[2] }];
			})[0] ?? null
	);
}

function resolveRecentAppFollowup(
	context: ResponseHandlerEvaluatorContext,
): RecentAppFollowup | null {
	if (context.messageHandler.processMessage === "STOP") return null;
	if (!hasRegisteredAppAction(context)) return null;
	const text = userRequestMessageText(context.message).trim();
	if (!text) return null;
	const app = findRecentLocalApp(context);
	if (!app) return null;

	if (OPEN_RECENT_APP.test(text)) return { kind: "launch", app, text };
	if (EXPLICIT_ELIZA_SURFACE.test(text)) return null;
	if (!VISUAL_EDIT_VERB.test(text) || !VISUAL_EDIT_TARGET.test(text)) {
		return null;
	}
	return { kind: "edit", app, text };
}

export const recentAppFollowupEvaluator: ResponseHandlerEvaluator = {
	name: "app-control.recent-app-followup",
	description:
		"Keeps short visual edits and open/launch follow-ups attached to the most recently completed local app.",
	priority: 10,
	deterministicActions: [APP_ACTION_NAME],
	shouldRun: (context) => resolveRecentAppFollowup(context) !== null,
	evaluate: (context) => {
		const followup = resolveRecentAppFollowup(context);
		if (!followup) return undefined;
		const params: Record<string, string | boolean> =
			followup.kind === "launch"
				? {
						action: "launch",
						mode: "launch",
						app: followup.app.slug,
						name: followup.app.slug,
					}
				: {
						action: "create",
						mode: "create",
						app: followup.app.slug,
						name: followup.app.displayName,
						title: followup.app.displayName,
						editTarget: followup.app.slug,
						intent: followup.text,
						verify: true,
					};
		return {
			requiresTool: true,
			clearReply: true,
			clearCandidateActions: true,
			addCandidateActions: [APP_ACTION_NAME],
			clearParentActionHints: true,
			addParentActionHints: [APP_ACTION_NAME],
			addContexts: [GENERAL_CONTEXT],
			deterministicToolCall: { name: APP_ACTION_NAME, params },
			debug: [
				`recent local app ${followup.app.slug} owns ${followup.kind} follow-up`,
			],
		};
	},
};
