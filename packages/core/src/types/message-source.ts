export const MESSAGE_SOURCE_CLIENT_CHAT = "client_chat" as const;
export const MESSAGE_SOURCE_SUB_AGENT = "sub_agent" as const;

export const MESSAGE_SOURCES = {
	CLIENT_CHAT: MESSAGE_SOURCE_CLIENT_CHAT,
	SUB_AGENT: MESSAGE_SOURCE_SUB_AGENT,
} as const;

export type MessageSourceSentinel =
	(typeof MESSAGE_SOURCES)[keyof typeof MESSAGE_SOURCES];
