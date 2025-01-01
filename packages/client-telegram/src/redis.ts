import Redis from "ioredis";
import { elizaLogger } from "@ai16z/eliza";

export class RedisService {
    private static instance: RedisService;
    public redis: Redis;
    public subscriber: Redis;
    public REDIS_URL: string;

    private constructor() {
        elizaLogger.log("📡 Initializing Redis Service...");
        this.REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

        // Initialize Redis clients
        this.redis = new Redis(this.REDIS_URL + "?family=0");
        this.subscriber = new Redis(this.REDIS_URL + "?family=0");

        this.setupErrorHandlers();
        this.setupGracefulShutdown();
        elizaLogger.log("✅ Redis Service initialized");
    }

    private setupErrorHandlers(): void {
        this.redis.on("error", (error) => {
            elizaLogger.error("Redis connection error:", error);
        });

        this.subscriber.on("error", (error) => {
            elizaLogger.error("Redis subscriber error:", error);
        });
    }

    private setupGracefulShutdown(): void {
        process.on("SIGTERM", async () => {
            await this.redis.quit();
            await this.subscriber.quit();
        });
    }

    public static getInstance(): RedisService {
        if (!RedisService.instance) {
            RedisService.instance = new RedisService();
        }
        return RedisService.instance;
    }
}
