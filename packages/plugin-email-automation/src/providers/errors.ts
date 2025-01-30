export class EmailProviderError extends Error {
    constructor(
        public provider: string,
        public originalError: unknown,
        public context?: Record<string, unknown>
    ) {
        super(`Error in ${provider} provider: ${originalError}`);
        this.name = 'EmailProviderError';
    }
}

// Export the factory function
export const createEmailProviderError = (
    provider: string,
    error: unknown,
    context?: Record<string, unknown>
): EmailProviderError => new EmailProviderError(provider, error, context);