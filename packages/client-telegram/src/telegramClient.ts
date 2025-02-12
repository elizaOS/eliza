import { Context, Telegraf } from "telegraf";
import { IAgentRuntime, elizaLogger } from "@ai16z/eliza";
import { MessageManager } from "./messageManager.ts";
import { getOrCreateRecommenderInBe } from "./getOrCreateRecommenderInBe.ts";
import { commands } from "./commands";
import { RedisService } from "./redis.ts";
import { SentimentService } from "./sentiment.ts";
import { BalanceCheckService } from "./balanceChecker.ts";

export class TelegramClient {
    private bot: Telegraf<Context>;
    private runtime: IAgentRuntime;
    private messageManager: MessageManager;
    private backend;
    private backendToken;
    private tgTrader;
    private checkPermissionsInterval: NodeJS.Timeout;
    private redisService: RedisService;
    private sentimentService: SentimentService;
    private balanceCheckService: BalanceCheckService;

    constructor(runtime: IAgentRuntime, botToken: string) {
        elizaLogger.log("📱 Constructing new TelegramClient...");
        this.runtime = runtime;
        this.bot = new Telegraf(botToken);
        this.redisService = RedisService.getInstance();
        this.balanceCheckService = BalanceCheckService.getInstance();

        this.messageManager = new MessageManager(this.bot, this.runtime);
        this.backend = runtime.getSetting("BACKEND_URL");
        this.backendToken = runtime.getSetting("BACKEND_TOKEN");
        this.tgTrader = runtime.getSetting("TG_TRADER");

        this.setupPermissionChecker();
        elizaLogger.log("✅ TelegramClient constructor completed");
    }

    public async start(): Promise<void> {
        elizaLogger.log("🚀 Starting Telegram bot...");
        try {
            await this.initializeBot();
            this.setupMessageHandlers();
            this.setupShutdownHandlers();
        } catch (error) {
            elizaLogger.error("❌ Failed to launch Telegram bot:", error);
            throw error;
        }
    }

    private async initializeBot(): Promise<void> {
        await this.bot.telegram.setMyCommands(
            commands.map((cmd) => ({
                command: cmd.command,
                description: cmd.description,
            }))
        );

        this.bot.launch({ dropPendingUpdates: true });
        elizaLogger.log(
            "✨ Telegram bot successfully launched and is running!"
        );

        const botInfo = await this.bot.telegram.getMe();
        this.bot.botInfo = botInfo;
        elizaLogger.success(`Bot username: @${botInfo.username}`);

        this.messageManager.bot = this.bot;
        this.sentimentService = new SentimentService(this.bot);
        elizaLogger.log("📊 Sentiment monitoring initialized");
    }

    private setupMessageHandlers(): void {
        elizaLogger.log("Setting up message handler...");

        commands.forEach((cmd) => {
            this.bot.command(cmd.command, (ctx) =>
                cmd.handler(ctx, this.runtime)
            );
        });

        this.bot.action("verify_account", async (ctx) => {
            const verifyCommand = commands.find(
                (cmd) => cmd.command === "verify"
            );
            if (verifyCommand) {
                await verifyCommand.handler(ctx, this.runtime);
            }
        });

        this.bot.on("message", async (ctx) => {
            try {
                if (this.tgTrader) {
                    const userId = ctx.from?.id.toString();
                    const username =
                        ctx.from?.username || ctx.from?.first_name || "Unknown";
                    if (!userId) {
                        elizaLogger.warn(
                            "Received message from a user without an ID."
                        );
                        return;
                    }
                    try {
                        await getOrCreateRecommenderInBe(
                            userId,
                            username,
                            this.backendToken,
                            this.backend
                        );
                    } catch (error) {
                        elizaLogger.error(
                            "Error getting or creating recommender in backend",
                            error
                        );
                    }
                }
                await this.messageManager.handleMessage(ctx);
            } catch (error) {
                elizaLogger.error("❌ Error handling message:", error);
                await ctx.reply(
                    "An error occurred while processing your message."
                );
            }
        });

        this.bot.on("photo", (ctx) => {
            elizaLogger.log(
                "📸 Received photo message with caption:",
                ctx.message.caption
            );
        });

        this.bot.on("document", (ctx) => {
            elizaLogger.log(
                "📎 Received document message:",
                ctx.message.document.file_name
            );
        });

        this.bot.catch((err, ctx) => {
            elizaLogger.error(`❌ Telegram Error for ${ctx.updateType}:`, err);
            // ctx.reply("An unexpected error occurred. Please try again later.");
        });
    }

    private setupShutdownHandlers(): void {
        const shutdownHandler = async (signal: string) => {
            elizaLogger.log(
                `⚠️ Received ${signal}. Shutting down Telegram bot gracefully...`
            );
            try {
                await this.stop();
                elizaLogger.log("🛑 Telegram bot stopped gracefully");
            } catch (error) {
                elizaLogger.error(
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
        elizaLogger.log("Stopping Telegram bot...");
        clearInterval(this.checkPermissionsInterval);
        await this.bot.stop();
        await this.sentimentService.stop();
        elizaLogger.log("Telegram bot stopped");
    }

    private setupPermissionChecker(): void {
        elizaLogger.log("Setting up permission checker...");
        this.checkPermissionsInterval = setInterval(async () => {
            try {
                const groupId = this.runtime.getSetting("PRIVATE_GROUP_ID");
                if (!groupId) {
                    elizaLogger.warn(
                        "PRIVATE_GROUP_ID not set, skipping permission check"
                    );
                    return;
                }

                await this.balanceCheckService.queue.add({
                    groupId,
                    timestamp: Date.now()
                });

                const users = await this.redisService.redis.keys("user:*:permissions");
                elizaLogger.log(
                    `Checking permissions for ${users.length} users in group ${groupId}`
                );

                const formattedGroupId = groupId.toString().startsWith("-100")
                    ? groupId.toString()
                    : `-100${groupId.toString().replace("-", "")}`;

                elizaLogger.log(
                    `Using formatted group ID: ${formattedGroupId}`
                );

                for (const userKey of users) {
                    try {
                        const permissions = await this.redisService.redis.get(userKey);
                        if (!permissions) {
                            elizaLogger.warn(
                                `No permissions found for ${userKey}`
                            );
                            continue;
                        }

                        const data = JSON.parse(permissions);
                        const userId = userKey.split(":")[1];
                        elizaLogger.log(
                            `Processing user ${userId} with data:`,
                            data
                        );

                        try {
                            const member =
                                await this.bot.telegram.getChatMember(
                                    formattedGroupId,
                                    userId
                                );
                            elizaLogger.log(
                                `Member status for ${userId}: ${member.status}`
                            );

                            if (
                                member.status === "creator" ||
                                member.status === "administrator"
                            ) {
                                elizaLogger.log(
                                    `Skipping check for ${member.status} ${userId}`
                                );
                                continue;
                            }

                            if (member.user.is_bot) {
                                await this.bot.telegram.banChatMember(
                                    formattedGroupId,
                                    userId
                                );
                                elizaLogger.log(
                                    `Removed bot ${userId} from the group (non-admin bot)`
                                );
                                continue;
                            }

                            if (!data.hasRequiredBalance) {
                                await this.bot.telegram.banChatMember(
                                    formattedGroupId,
                                    userId
                                );
                                elizaLogger.log(
                                    `Removed user ${userId} from the group due to insufficient tokens`
                                );
                            }
                        } catch (error) {
                            elizaLogger.error(
                                `Error checking member ${userId}:`,
                                error
                            );
                            elizaLogger.error(`Error details:`, {
                                message: error.message,
                                description: error.description,
                                code: error.code,
                            });
                        }

                        await this.redisService.redis.del(userKey);
                    } catch (error) {
                        elizaLogger.error(
                            `Error processing key ${userKey}:`,
                            error
                        );
                    }
                }
            } catch (error) {
                elizaLogger.error("Permission check error:", {
                    message: error.message,
                    stack: error.stack,
                    details: error,
                });
            }
        }, 60000);
    }
}
