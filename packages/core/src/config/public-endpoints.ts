/** Canonical public endpoints used by backend configuration and API clients. */
export const EXTERNAL_URLS = {
	marketing: "https://eliza.app",
	app: "https://cloud.eliza.app",
	cloud: "https://cloud.eliza.app",
	cloudApi: "https://api.eliza.app",
	os: "https://os.eliza.app",
	docs: "https://docs.elizaos.ai",
	github: "https://github.com/elizaOS/eliza",
	discord: "https://discord.gg/eliza",
	twitter: "https://x.com/elizaos",
} as const;

export type ExternalUrlKey = keyof typeof EXTERNAL_URLS;
