import type { Config } from 'drizzle-kit';

export default {
  schema: './src/persistence/schema.ts',
  out: './drizzle',
  driver: 'pg',
  dbCredentials: {
    connectionString: process.env.DATABASE_URL || 'postgresql://localhost:5432/dnd_vtt',
  },
} satisfies Config;
