import { config } from 'dotenv';
import { beforeAll } from 'vitest';
import { resolve } from 'path';

// Load environment variables from .env file
beforeAll(() => {
  config({ path: resolve(process.cwd(), '.env') });

  // Check if required environment variables are set
  if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
    console.warn('⚠️  GOOGLE_GENERATIVE_AI_API_KEY not found in .env file. Tests may fail.');
  }
});
