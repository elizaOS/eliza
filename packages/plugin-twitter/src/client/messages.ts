import type { TwitterAuth } from "./auth";
import { updateCookieJar } from "./requests";

export interface DirectMessage {
	id: string;
	text: string;
	senderId: string;
	recipientId: string;
	createdAt: string;
	mediaUrls?: string[];
	senderScreenName?: string;
	recipientScreenName?: string;
}

export interface DirectMessageConversation {
	conversationId: string;
	messages: DirectMessage[];
	participants: {
		id: string;
		screenName: string;
	}[];
}

export interface DirectMessageEvent {
	id: string;
	type: string;
	message_create: {
		sender_id: string;
		target: {
			recipient_id: string;
		};
		message_data: {
			text: string;
			created_at: string;
			entities?: {
				urls?: Array<{
					url: string;
					expanded_url: string;
					display_url: string;
				}>;
				media?: Array<{
					url: string;
					type: string;
				}>;
			};
		};
	};
}

export interface DirectMessagesResponse {
	conversations: DirectMessageConversation[];
	users: TwitterUser[];
	cursor?: string;
	lastSeenEventId?: string;
	trustedLastSeenEventId?: string;
	untrustedLastSeenEventId?: string;
	inboxTimelines?: {
		trusted?: {
			status: string;
			minEntryId?: string;
		};
		untrusted?: {
			status: string;
			minEntryId?: string;
		};
	};
	userId: string;
}

export interface TwitterUser {
	id: string;
	screenName: string;
	name: string;
	profileImageUrl: string;
	description?: string;
	verified?: boolean;
	protected?: boolean;
	followersCount?: number;
	friendsCount?: number;
}

export interface SendDirectMessageResponse {
	entries: {
		message: {
			id: string;
			time: string;
			affects_sort: boolean;
			conversation_id: string;
			message_data: {
				id: string;
				time: string;
				recipient_id: string;
				sender_id: string;
				text: string;
			};
		};
	}[];
	users: Record<string, TwitterUser>;
}

function parseDirectMessageConversations(
	data: any,
	userId: string,
): DirectMessagesResponse {
	try {
		const inboxState = data?.inbox_initial_state;
		const conversations = inboxState?.conversations || {};
		const entries = inboxState?.entries || [];
		const users = inboxState?.users || {};

		// Parse users first
		const parsedUsers: TwitterUser[] = Object.values(users).map(
			(user: any) => ({
				id: user.id_str,
				screenName: user.screen_name,
				name: user.name,
				profileImageUrl: user.profile_image_url_https,
				description: user.description,
				verified: user.verified,
				protected: user.protected,
				followersCount: user.followers_count,
				friendsCount: user.friends_count,
			}),
		);

		// Group messages by conversation_id
		const messagesByConversation: Record<string, any[]> = {};
		entries.forEach((entry: any) => {
			if (entry.message) {
				const convId = entry.message.conversation_id;
				if (!messagesByConversation[convId]) {
					messagesByConversation[convId] = [];
				}
				messagesByConversation[convId].push(entry.message);
			}
		});

		// Convert to DirectMessageConversation array
		const parsedConversations = Object.entries(conversations).map(
			([convId, conv]: [string, any]) => {
				const messages = messagesByConversation[convId] || [];

				// Sort messages by time in ascending order
				messages.sort((a, b) => Number(a.time) - Number(b.time));

				return {
					conversationId: convId,
					messages: parseDirectMessages(messages, users),
					participants: conv.participants.map((p: any) => ({
						id: p.user_id,
						screenName: users[p.user_id]?.screen_name || p.user_id,
					})),
				};
			},
		);

		return {
			conversations: parsedConversations,
			users: parsedUsers,
			cursor: inboxState?.cursor,
			lastSeenEventId: inboxState?.last_seen_event_id,
			trustedLastSeenEventId: inboxState?.trusted_last_seen_event_id,
			untrustedLastSeenEventId: inboxState?.untrusted_last_seen_event_id,
			inboxTimelines: {
				trusted: inboxState?.inbox_timelines?.trusted && {
					status: inboxState.inbox_timelines.trusted.status,
					minEntryId: inboxState.inbox_timelines.trusted.min_entry_id,
				},
				untrusted: inboxState?.inbox_timelines?.untrusted && {
					status: inboxState.inbox_timelines.untrusted.status,
					minEntryId: inboxState.inbox_timelines.untrusted.min_entry_id,
				},
			},
			userId,
		};
	} catch (error) {
		console.error("Error parsing DM conversations:", error);
		return {
			conversations: [],
			users: [],
			userId,
		};
	}
}

function parseDirectMessages(messages: any[], users: any): DirectMessage[] {
	try {
		return messages.map((msg: any) => ({
			id: msg.message_data.id,
			text: msg.message_data.text,
			senderId: msg.message_data.sender_id,
			recipientId: msg.message_data.recipient_id,
			createdAt: msg.message_data.time,
			mediaUrls: extractMediaUrls(msg.message_data),
			senderScreenName: users[msg.message_data.sender_id]?.screen_name,
			recipientScreenName: users[msg.message_data.recipient_id]?.screen_name,
		}));
	} catch (error) {
		console.error("Error parsing DMs:", error);
		return [];
	}
}

function extractMediaUrls(messageData: any): string[] | undefined {
	const urls: string[] = [];

	// Extract URLs from entities if they exist
	if (messageData.entities?.urls) {
		messageData.entities.urls.forEach((url: any) => {
			urls.push(url.expanded_url);
		});
	}

	// Extract media URLs if they exist
	if (messageData.entities?.media) {
		messageData.entities.media.forEach((media: any) => {
			urls.push(media.media_url_https || media.media_url);
		});
	}

	return urls.length > 0 ? urls : undefined;
}

export async function getDirectMessageConversations(
	userId: string,
	auth: TwitterAuth,
	cursor?: string,
): Promise<DirectMessagesResponse> {
	if (!auth.isLoggedIn()) {
		throw new Error("Authentication required to fetch direct messages");
	}

	const url =
		"https://twitter.com/i/api/graphql/7s3kOODhC5vgXlO0OlqYdA/DMInboxTimeline";
	const messageListUrl = "https://x.com/i/api/1.1/dm/inbox_initial_state.json";

	const params = new URLSearchParams();

	if (cursor) {
		params.append("cursor", cursor);
	}

	const finalUrl = `${messageListUrl}${
		params.toString() ? `?${params.toString()}` : ""
	}`;
	const cookies = await auth.cookieJar().getCookies(url);
	const xCsrfToken = cookies.find((cookie) => cookie.key === "ct0");

	const headers = new Headers({
		authorization: `Bearer ${(auth as any).bearerToken}`,
		cookie: await auth.cookieJar().getCookieString(url),
		"content-type": "application/json",
		"User-Agent":
			"Mozilla/5.0 (Linux; Android 11; Nokia G20) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.88 Mobile Safari/537.36",
		"x-guest-token": (auth as any).guestToken,
		"x-twitter-auth-type": "OAuth2Client",
		"x-twitter-active-user": "yes",
		"x-csrf-token": xCsrfToken?.value as string,
	});

	const response = await fetch(finalUrl, {
		method: "GET",
		headers,
	});

	await updateCookieJar(auth.cookieJar(), response.headers);

	if (!response.ok) {
		throw new Error(await response.text());
	}

	// parse the response
	const data = await response.json();
	return parseDirectMessageConversations(data, userId);
}

export async function sendDirectMessage(
	auth: TwitterAuth,
	conversation_id: string,
	text: string,
): Promise<SendDirectMessageResponse> {
	if (!auth.isLoggedIn()) {
		throw new Error("Authentication required to send direct messages");
	}

	const url =
		"https://twitter.com/i/api/graphql/7s3kOODhC5vgXlO0OlqYdA/DMInboxTimeline";
	const messageDmUrl = "https://x.com/i/api/1.1/dm/new2.json";

	const cookies = await auth.cookieJar().getCookies(url);
	const xCsrfToken = cookies.find((cookie) => cookie.key === "ct0");

	const headers = new Headers({
		authorization: `Bearer ${(auth as any).bearerToken}`,
		cookie: await auth.cookieJar().getCookieString(url),
		"content-type": "application/json",
		"User-Agent":
			"Mozilla/5.0 (Linux; Android 11; Nokia G20) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.88 Mobile Safari/537.36",
		"x-guest-token": (auth as any).guestToken,
		"x-twitter-auth-type": "OAuth2Client",
		"x-twitter-active-user": "yes",
		"x-csrf-token": xCsrfToken?.value as string,
	});

	const payload = {
		conversation_id: `${conversation_id}`,
		recipient_ids: false,
		text: text,
		cards_platform: "Web-12",
		include_cards: 1,
		include_quote_count: true,
		dm_users: false,
	};

	const response = await fetch(messageDmUrl, {
		method: "POST",
		headers,
		body: JSON.stringify(payload),
	});

	await updateCookieJar(auth.cookieJar(), response.headers);

	if (!response.ok) {
		throw new Error(await response.text());
	}

	return await response.json();
}
