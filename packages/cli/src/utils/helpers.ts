import type { Agent, MessageExample } from "@elizaos/core";
import { logger } from "@elizaos/core";
import colors from "yoctocolors";

/**
 * Display character
 */
export function displayAgent(
	data: Partial<Agent>,
	title = "Agent Review",
): void {
	logHeader(title);

	// Display basic info
	logger.info(`Name: ${data.name}`);
	logger.info(
		`Username: ${data.username || data.name?.toLowerCase().replace(/\s+/g, "_")}`,
	);

	// Display bio
	logger.info("\nBio:");
	for (const line of Array.isArray(data.bio) ? data.bio : [data.bio]) {
		logger.info(`  ${line}`);
	}

	// Display adjectives
	logger.info("\nAdjectives:");
	for (const adj of data.adjectives || []) {
		logger.info(`  ${adj}`);
	}

	// Display topics
	if (data.topics && data.topics.length > 0) {
		logger.info("\nTopics:");
		for (const topic of data.topics) {
			logger.info(`  ${topic}`);
		}
	}

	// Display plugins
	if (data.plugins && data.plugins.length > 0) {
		logger.info("\nPlugins:");
		for (const plugin of data.plugins) {
			logger.info(`  ${plugin}`);
		}
	}

	// Display style
	if (data.style) {
		if (data.style.all && data.style.all.length > 0) {
			logger.info("\nGeneral Style:");
			for (const style of data.style.all) {
				logger.info(`  ${style}`);
			}
		}
		if (data.style.chat && data.style.chat.length > 0) {
			logger.info("\nChat Style:");
			for (const style of data.style.chat) {
				logger.info(`  ${style}`);
			}
		}
		if (data.style.post && data.style.post.length > 0) {
			logger.info("\nPost Style:");
			for (const style of data.style.post) {
				logger.info(`  ${style}`);
			}
		}
	}

	// Display post examples
	if (data.postExamples && data.postExamples.length > 0) {
		logger.info("\nPost Examples:");
		for (const post of data.postExamples) {
			logger.info(`  ${post}`);
		}
	}

	// Display message examples
	if (data.messageExamples && data.messageExamples.length > 0) {
		logger.info("\nMessage Examples:");
		logger.info(data.messageExamples.map((conversation, i) => {
			const messages = conversation
				.map((msg) => {
					const user = msg.name === "{{name1}}" ? "Anon" : msg.name;
					return `${user}: ${msg.content.text}`;
				})
				.join("\n");
			return `\nConversation ${i + 1}:\n${messages}`;
		})
		.join("\n"));
	}
}

/**
 * Logs a header inside a rectangular frame with extra padding.
 * @param {string} title - The header text to display.
 */
function logHeader(title) {
	const padding = 2; // number of spaces on each side
	const titleStr = `=== ${title} ===`;
	const paddedTitle = " ".repeat(padding) + titleStr + " ".repeat(padding);
	const borderLength = paddedTitle.length;

	// Create top and bottom borders using Unicode box drawing characters
	const topBorder = colors.green(`┌${"─".repeat(borderLength)}┐`);
	const bottomBorder = colors.green(`└${"─".repeat(borderLength)}┘`);
	const middleRow = colors.green(`│${paddedTitle}│`);

	// Log the rectangle with a leading new line for spacing
	logger.info(`\n${topBorder}\n${middleRow}\n${bottomBorder}`);
}
