/**
 * Discord-native addressing helper.
 *
 * A bot can be mentioned as the subject of a message addressed to someone else.
 * Connector routing should only treat the bot as directly addressed when the
 * platform facts say so: the message replies to the bot, or the first user
 * mention in the raw Discord content is the bot.
 */

function readUserMentionAt(text: string, start: number): string | null {
	if (text[start] !== "<" || text[start + 1] !== "@") return null;
	let index = start + 2;
	if (text[index] === "!") index += 1;
	const idStart = index;
	while (index < text.length) {
		const code = text.charCodeAt(index);
		if (code < 48 || code > 57) break;
		index += 1;
	}
	if (index === idStart || text[index] !== ">") return null;
	return text.slice(idStart, index);
}

function firstUserMentionId(text: string): string | null {
	for (let index = 0; index < text.length; index += 1) {
		if (text[index] !== "<") continue;
		const mentionId = readUserMentionAt(text, index);
		if (mentionId) return mentionId;
	}
	return null;
}

export function isDiscordUserAddressed({
	text,
	userId,
	hasMessageReference = false,
	repliedUserId,
}: {
	text?: string | null;
	userId?: string | null;
	hasMessageReference?: boolean;
	repliedUserId?: string | null;
}): boolean {
	if (userId && hasMessageReference && repliedUserId === userId) {
		return true;
	}
	return Boolean(userId && firstUserMentionId(text ?? "") === userId);
}
