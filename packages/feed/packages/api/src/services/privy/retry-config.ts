export function getRetryConfig(): { maxAttempts: number; delayMs: number } {
  const isTest = process.env.NODE_ENV === 'test';
  return {
    maxAttempts: isTest ? 1 : 8,
    delayMs: isTest ? 0 : 250,
  };
}
