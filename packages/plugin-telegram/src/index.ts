import {
	Service,
	type IAgentRuntime,
	logger,
	type Plugin,
} from "@elizaos/core";
import { type Context, Telegraf } from "telegraf";
import { validateTelegramConfig } from "./environment.ts";
import { MessageManager } from "./messageManager.ts";
import { TelegramTestSuite } from "./tests.ts";
import { TELEGRAM_SERVICE_NAME } from "./constants.ts";

/**
 * Class representing a Telegram service that allows the agent to send and receive messages on Telegram.
 * @extends Service
 */
export class TelegramService extends Service {
	static serviceType = TELEGRAM_SERVICE_NAME;
	capabilityDescription =
		"The agent is able to send and receive messages on telegram";
	private bot: Telegraf<Context>;
	public messageManager: MessageManager;
	private options;

	/**
	 * Constructor for TelegramService class.
	 * @param {IAgentRuntime} runtime - The runtime object for the agent.
	 */
	constructor(runtime: IAgentRuntime) {
		super(runtime);
		logger.log("📱 Constructing new TelegramService...");
		this.options = {
			telegram: {
				apiRoot:
					runtime.getSetting("TELEGRAM_API_ROOT") ||
					process.env.TELEGRAM_API_ROOT ||
					"https://api.telegram.org",
			},
		};
		const botToken = runtime.getSetting("TELEGRAM_BOT_TOKEN");
		this.bot = new Telegraf(botToken, this.options);
		this.messageManager = new MessageManager(this.bot, this.runtime);
		logger.log("✅ TelegramService constructor completed");
	}

	/**
	 * Starts the Telegram service for the given runtime.
	 *
	 * @param {IAgentRuntime} runtime - The agent runtime to start the Telegram service for.
	 * @returns {Promise<TelegramService>} A promise that resolves with the initialized TelegramService.
	 */
	static async start(runtime: IAgentRuntime): Promise<TelegramService> {
		await validateTelegramConfig(runtime);

		const tg = new TelegramService(runtime);

		logger.success(
			`✅ Telegram client successfully started for character ${runtime.character.name}`,
		);

		logger.log("🚀 Starting Telegram bot...");
		try {
			await tg.initializeBot();
			tg.setupMessageHandlers();
		} catch (error) {
			logger.error("❌ Failed to launch Telegram bot:", error);
			throw error;
		}
		return tg;
	}

	/**
	 * Stops the agent runtime.
	 * @param {IAgentRuntime} runtime - The agent runtime to stop
	 */
	static async stop(runtime: IAgentRuntime) {
		// Implement shutdown if necessary
		const tgClient = runtime.getService(TELEGRAM_SERVICE_NAME);
		if (tgClient) {
			await tgClient.stop();
		}
	}

	/**
	 * Asynchronously stops the bot.
	 *
	 * @returns A Promise that resolves once the bot has stopped.
	 */
	async stop(): Promise<void> {
		this.bot.stop();
	}

	/**
	 * Initializes the Telegram bot by launching it, getting bot info, and setting up message manager.
	 * @returns {Promise<void>} A Promise that resolves when the initialization is complete.
	 */
	private async initializeBot(): Promise<void> {
		this.bot.launch({
			dropPendingUpdates: true,
			allowedUpdates: ["message", "message_reaction"],
		});
		logger.log("✨ Telegram bot successfully launched and is running!");

		const botInfo = await this.bot.telegram.getMe();
		this.bot.botInfo = botInfo;
		logger.success(`Bot username: @${botInfo.username}`);

		this.messageManager.bot = this.bot;

		// Emit standardized event that we've connected
		// this.runtime.emitEvent("SERVER_CONNECTED", {
		//     name: "Telegram",
		//     runtime: this.runtime,
		//     server: {
		//         id: "telegram-main",
		//         name: "Telegram"
		//     },
		//     source: "telegram"
		// });
	}

	/**
	 * Checks if the group is authorized based on the Telegram settings.
	 *
	 * @param {Context} ctx - The context object representing the incoming message.
	 * @returns {Promise<boolean>} A Promise that resolves to a boolean indicating if the group is authorized.
	 */
	private async isGroupAuthorized(ctx: Context): Promise<boolean> {
		const config = this.runtime.character.settings?.telegram;
		if (ctx.from?.id === ctx.botInfo?.id) {
			return false;
		}

		if (!config?.shouldOnlyJoinInAllowedGroups) {
			return true;
		}

		const allowedGroups = config.allowedGroupIds || [];
		const currentGroupId = ctx.chat.id.toString();

		if (!allowedGroups.includes(currentGroupId)) {
			logger.info(`Unauthorized group detected: ${currentGroupId}`);
			try {
				await ctx.reply("Not authorized. Leaving.");
				await ctx.leaveChat();
			} catch (error) {
				logger.error(
					`Error leaving unauthorized group ${currentGroupId}:`,
					error,
				);
			}
			return false;
		}

		return true;
	}

	/**
	 * Set up message handlers for the bot.
	 *
	 * @private
	 * @returns {void}
	 */
	private setupMessageHandlers(): void {
		// Regular message handler
		this.bot.on("message", async (ctx) => {
			try {
				if (!(await this.isGroupAuthorized(ctx))) return;
				await this.messageManager.handleMessage(ctx);
			} catch (error) {
				logger.error("Error handling message:", error);
			}
		});

		// Reaction handler
		this.bot.on("message_reaction", async (ctx) => {
			try {
				if (!(await this.isGroupAuthorized(ctx))) return;
				await this.messageManager.handleReaction(ctx);
			} catch (error) {
				logger.error("Error handling reaction:", error);
			}
		});
	}
}

const telegramPlugin: Plugin = {
	name: TELEGRAM_SERVICE_NAME,
	description: "Telegram client plugin",
	services: [TelegramService],
	tests: [new TelegramTestSuite()],
};
export default telegramPlugin;
