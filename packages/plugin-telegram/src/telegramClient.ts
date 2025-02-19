import { type Context, Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import { type IAgentRuntime, logger, type ClientInstance, stringToUuid, Memory, HandlerCallback, Content } from "@elizaos/core";
import { MessageManager } from "./messageManager.ts";

export class TelegramClient implements ClientInstance {
    name = "telegram";
    private bot: Telegraf<Context>;
    private runtime: IAgentRuntime;
    public messageManager: MessageManager;
    private options;

    constructor(runtime: IAgentRuntime, botToken: string) {
        logger.log("📱 Constructing new TelegramClient...");
        this.options = {
            telegram: {
                apiRoot: runtime.getSetting("TELEGRAM_API_ROOT") || process.env.TELEGRAM_API_ROOT || "https://api.telegram.org"
            },
        };
        this.runtime = runtime;
        this.bot = new Telegraf(botToken,this.options);
        this.messageManager = new MessageManager(this.bot, this.runtime);
        logger.log("✅ TelegramClient constructor completed");
    }

    public async start(): Promise<void> {
        logger.log("🚀 Starting Telegram bot...");
        try {
            await this.initializeBot();
            this.setupMessageHandlers();
            this.setupShutdownHandlers();
        } catch (error) {
            logger.error("❌ Failed to launch Telegram bot:", error);
            throw error;
        }
    }

    private async initializeBot(): Promise<void> {
        this.bot.launch({ dropPendingUpdates: true, allowedUpdates: [ "message", "message_reaction" ] });
        logger.log(
            "✨ Telegram bot successfully launched and is running!"
        );

        const botInfo = await this.bot.telegram.getMe();
        this.bot.botInfo = botInfo;
        logger.success(`Bot username: @${botInfo.username}`);

        this.messageManager.bot = this.bot;
    }

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
                    error
                );
            }
            return false;
        }

        return true;
    }

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

    private setupShutdownHandlers(): void {
        const shutdownHandler = async (signal: string) => {
            logger.log(
                `⚠️ Received ${signal}. Shutting down Telegram bot gracefully...`
            );
            try {
                await this.stop();
                logger.log("🛑 Telegram bot stopped gracefully");
            } catch (error) {
                logger.error(
                    "❌ Error during Telegram bot shutdown:",
                    error
                );
                throw error;
            }
        };

        process.once("SIGINT", () => shutdownHandler("SIGINT"));
        process.once("SIGTERM", () => shutdownHandler("SIGTERM"));
        process.once("SIGHUP", () => shutdownHandler("SIGHUP"));
    }

    public async stop(): Promise<void> {
        logger.log("Stopping Telegram bot...");
        //await 
            this.bot.stop();
        logger.log("Telegram bot stopped");
    }
}
