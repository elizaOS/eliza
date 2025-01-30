import { RateLimiterMemory } from "rate-limiter-flexible";

interface RateLimiterConfig {
    maxRequests?: number;
    windowMs?: number;
    maxRetries?: number;
    retryDelay?: number;
}

interface RateLimitError extends Error {
    remainingPoints: number;
    msBeforeNext: number;
}

export class RateLimiter {
    private limiter: RateLimiterMemory;
    private maxRetries: number;
    private retryDelay: number;

    constructor(config: RateLimiterConfig = {}) {
        this.limiter = new RateLimiterMemory({
            points: config.maxRequests || 100,
            duration: (config.windowMs || 60000) / 1000, // Convert ms to seconds
        });
        this.maxRetries = config.maxRetries || 3;
        this.retryDelay = config.retryDelay || 1000;
    }

    async consume(key: string, points = 1): Promise<void> {
        try {
            await this.limiter.consume(key, points);
        } catch (error: unknown) {
            if (error instanceof Error && 'remainingPoints' in error) {
                const rateLimitError = error as RateLimitError;
                const retryAfter = Math.ceil(rateLimitError.msBeforeNext / 1000);
                throw new Error(
                    `Rate limit exceeded. Retry after ${retryAfter} seconds`
                );
            }
            throw error;
        }
    }

    async executeWithRetry<T>(
        key: string,
        operation: () => Promise<T>,
        points = 1
    ): Promise<T> {
        let lastError: Error | null = null;
        let retries = 0;

        while (retries <= this.maxRetries) {
            try {
                await this.consume(key, points);
                return await operation();
            } catch (error: unknown) {
                lastError = error as Error;
                retries++;

                if (error instanceof Error && error.message?.includes("Rate limit exceeded")) {
                    const retryAfter = Number.parseInt(
                        error.message.match(/\d+/)?.[0] || "1",
                        10
                    );
                    await new Promise((resolve) =>
                        setTimeout(resolve, retryAfter * 1000)
                    );
                } else if (retries <= this.maxRetries) {
                    await new Promise((resolve) =>
                        setTimeout(resolve, this.retryDelay * retries)
                    );
                } else {
                    break;
                }
            }
        }

        throw new Error(
            `Operation failed after ${retries} retries. Last error: ${lastError?.message}`
        );
    }

    async cleanup(): Promise<void> {
        // Cleanup any resources if needed
    }

    async getRemainingPoints(key: string): Promise<number> {
        const res = await this.limiter.get(key);
        return res?.remainingPoints ?? 0;
    }

    async reset(key: string): Promise<void> {
        await this.limiter.delete(key);
    }

    async isRateLimited(key: string): Promise<boolean> {
        try {
            await this.limiter.get(key);
            return false;
        } catch {
            return true;
        }
    }
}
