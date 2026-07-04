/**
 * Well-known `source` sentinels for messages the agent originates or routes
 * internally (client chat, sub-agent, coding-agent, agent greeting), so routing
 * and gating code can branch on provenance without magic strings.
 */
export const MESSAGE_SOURCE_CLIENT_CHAT = "client_chat" as const;
export const MESSAGE_SOURCE_SUB_AGENT = "sub_agent" as const;
export const MESSAGE_SOURCE_CODING_AGENT = "coding-agent" as const;
export const MESSAGE_SOURCE_AGENT_GREETING = "agent_greeting" as const;

export const MESSAGE_SOURCES = {
	CLIENT_CHAT: MESSAGE_SOURCE_CLIENT_CHAT,
	SUB_AGENT: MESSAGE_SOURCE_SUB_AGENT,
	CODING_AGENT: MESSAGE_SOURCE_CODING_AGENT,
	AGENT_GREETING: MESSAGE_SOURCE_AGENT_GREETING,
} as const;

export type MessageSourceSentinel =
	(typeof MESSAGE_SOURCES)[keyof typeof MESSAGE_SOURCES];
