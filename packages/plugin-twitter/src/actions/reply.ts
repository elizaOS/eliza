import {
	type Action,
	type ActionExample,
	type HandlerCallback,
	type IAgentRuntime,
	type Memory,
	type State,
	logger,
} from "@elizaos/core";

const twitterReplyAction = {
	name: "REPLY",
	similes: ["REPLY_TO_TWEET", "SEND_REPLY", "RESPOND", "ANSWER_TWEET"],
	description:
		"Replies to the current tweet with the text from the generated message. Default if the agent is responding with a message and no other action.",
	validate: async (_runtime: IAgentRuntime, message: Memory, _state: State) => {
		// Only validate for Twitter messages
		if (message.content.source !== "twitter") {
			return false;
		}

		return true;
	},
	handler: async (
		_runtime: IAgentRuntime,
		_message: Memory,
		_state: State,
		_options: any,
		callback: HandlerCallback,
		responses: Memory[],
	) => {
		try {
			for (const response of responses) {
				// Call the callback to handle any additional processing
				await callback(response.content);
			}
		} catch (error) {
			logger.error("Error in Twitter reply action:", error);
			throw error;
		}
	},
	examples: [
		[
			{
				name: "{{name1}}",
				content: {
					text: "{{name2}} What do you think about the latest AI developments?",
				},
			},
			{
				name: "{{name2}}",
				content: {
					text: "The rapid progress in AI is fascinating! I'm particularly excited about advances in multimodal models and their practical applications.",
					actions: ["REPLY"],
				},
			},
		],
		[
			{
				name: "{{name1}}",
				content: {
					text: "Hey {{name2}}, can you explain quantum computing?",
				},
			},
			{
				name: "{{name2}}",
				content: {
					text: "Let me explain quantum computing in simple terms! Instead of classical bits that are either 0 or 1, quantum computers use quantum bits that can exist in multiple states simultaneously.",
					actions: ["REPLY"],
				},
			},
		],
		[
			{
				name: "{{name1}}",
				content: {
					text: "{{name2}} What's your favorite programming language?",
				},
			},
			{
				name: "{{name2}}",
				content: {
					text: "I love working with Python! The simplicity and readability make it perfect for both quick scripts and complex AI applications.",
					actions: ["REPLY"],
				},
			},
		],
		[
			{
				name: "{{name1}}",
				content: {
					text: "{{name2}} Have you seen the latest research on transformer models?",
				},
			},
			{
				name: "{{name2}}",
				content: {
					text: "Yes! The improvements in efficiency and context length are really promising for advancing natural language understanding.",
					actions: ["REPLY"],
				},
			},
		],
	] as ActionExample[][],
} as Action;

export default twitterReplyAction;
