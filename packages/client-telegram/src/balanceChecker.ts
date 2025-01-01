import Bull from 'bull';
import { elizaLogger } from '@ai16z/eliza';
import { RedisService } from './redis';

export class BalanceCheckService {
    private static instance: BalanceCheckService;
    public queue: Bull.Queue;
    private redisService: RedisService;

    private constructor() {
        elizaLogger.log("💰 Initializing Balance Check Service...");
        this.redisService = RedisService.getInstance();

        this.queue = new Bull('balance-checks', this.redisService.REDIS_URL, {
            defaultJobOptions: {
                removeOnComplete: true,
                removeOnFail: true,
            },
            redis: {
                family: 0  // Force IPv4
            }
        });

        this.setupErrorHandlers();
        elizaLogger.log("✅ Balance Check Service initialized");
    }

    private setupErrorHandlers(): void {
        this.queue.on('error', (error) => {
            elizaLogger.error('Balance check queue error:', error);
        });
    }

    public async stop(): Promise<void> {
        elizaLogger.log("Stopping balance check queue...");
        await this.queue.close();
    }

    public static getInstance(): BalanceCheckService {
        if (!BalanceCheckService.instance) {
            BalanceCheckService.instance = new BalanceCheckService();
        }
        return BalanceCheckService.instance;
    }
}
