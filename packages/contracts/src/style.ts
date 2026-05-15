/**
 * Character style / persona type contracts.
 *
 * Shapes consumed by the onboarding flow and the character loader.
 * Pure types only — no runtime catalogs or normalizers.
 */

export const CHARACTER_LANGUAGES = ['en', 'zh-CN', 'ko', 'es', 'pt', 'vi', 'tl'] as const;

export type CharacterLanguage = (typeof CHARACTER_LANGUAGES)[number];

export interface StylePreset {
	id: string;
	name: string;
	avatarIndex: number;
	voicePresetId: string;
	greetingAnimation: string;
	catchphrase: string;
	hint: string;
	bio: string[];
	system: string;
	adjectives: string[];
	style: {
		all: string[];
		chat: string[];
		post: string[];
	};
	topics: string[];
	postExamples: string[];
	postExamples_zhCN?: string[];
	messageExamples: Array<
		Array<{
			user: string;
			content: { text: string };
		}>
	>;
}

export interface MessageExampleContent {
	text: string;
	actions?: string[];
}

export interface MessageExample {
	user: string;
	content: MessageExampleContent;
}
