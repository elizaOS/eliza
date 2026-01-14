export class RateLimiter {
  private queue: Array<() => Promise<any>> = [];
  private processing = false;
  private lastRequestTime = 0;

  constructor(
    private minDelay: number = 1000, // Minimum delay between requests in ms
    private maxRetries: number = 3,
    private backoffMultiplier: number = 2
  ) {}

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        let retries = 0;
        let delay = this.minDelay;

        while (retries < this.maxRetries) {
          try {
            // Ensure minimum delay between requests
            const now = Date.now();
            const timeSinceLastRequest = now - this.lastRequestTime;
            if (timeSinceLastRequest < this.minDelay) {
              await new Promise((res) => setTimeout(res, this.minDelay - timeSinceLastRequest));
            }

            this.lastRequestTime = Date.now();
            const result = await fn();
            resolve(result);
            return;
          } catch (error: any) {
            retries++;

            // Check if it's a rate limit error
            if (error.message?.includes('429') || error.status === 429) {
              console.log(
                `Rate limited. Waiting ${delay}ms before retry ${retries}/${this.maxRetries}...`
              );
              await new Promise((res) => setTimeout(res, delay));
              delay *= this.backoffMultiplier;
            } else {
              // Not a rate limit error, reject immediately
              reject(error);
              return;
            }
          }
        }

        reject(new Error(`Failed after ${this.maxRetries} retries`));
      });

      this.processQueue();
    });
  }

  private async processQueue() {
    if (this.processing) return;

    this.processing = true;
    while (this.queue.length > 0) {
      const task = this.queue.shift();
      if (task) {
        await task();
      }
    }
    this.processing = false;
  }
}
