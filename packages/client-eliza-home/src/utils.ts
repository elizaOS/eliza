import { elizaLogger } from "@elizaos/core";

export async function retryWithBackoff<T>(
    operation: () => Promise<T>,
    maxRetries: number = 3,
    baseDelay: number = 1000
): Promise<T> {
    let lastError: Error;

    for (let i = 0; i < maxRetries; i++) {
        try {
            return await operation();
        } catch (error) {
            lastError = error;
            const delay = baseDelay * Math.pow(2, i);
            elizaLogger.warn(`Operation failed, retrying in ${delay}ms...`, error);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }

    throw lastError!;
}

export function parseEntityId(entityId: string): { domain: string; name: string } {
    const [domain, ...rest] = entityId.split('.');
    return {
        domain,
        name: rest.join('.'),
    };
}

export function formatResponse(success: boolean, message: string, data?: any) {
    return {
        success,
        message,
        data,
        timestamp: new Date().toISOString(),
    };
}