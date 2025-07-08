import { z } from 'zod';

/**
 * Zod schema for create command options validation
 */
export const initOptionsSchema = z.object({
  yes: z.boolean().default(false),
  type: z.enum(['project', 'plugin', 'agent', 'tee']).default('project'),
});

export type CreateOptions = z.infer<typeof initOptionsSchema>;

/**
 * Available AI model configuration
 */
export interface AIModelOption {
  title: string;
  value: string;
  description: string;
}

/**
 * Available database configuration
 */
export interface DatabaseOption {
  title: string;
  value: string;
  description: string;
}
