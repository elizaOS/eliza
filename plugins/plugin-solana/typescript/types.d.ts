/**
 * Type declarations to fix compatibility issues with exactOptionalPropertyTypes
 * This fixes the conflict between @types/node ProcessEnv and Bun's Env interface
 *
 * The issue: @types/node declares TZ?: string | undefined, but Bun's Env declares TZ?: string
 * With exactOptionalPropertyTypes: true, these are incompatible.
 *
 * Solution: Redeclare ProcessEnv to match Bun's stricter typing
 */

declare global {
  namespace NodeJS {
    // Override @types/node ProcessEnv to be compatible with Bun's Env interface
    interface ProcessEnv {
      [key: string]: string | undefined;
      // Remove the explicit '| undefined' from TZ to match Bun's Env
      TZ?: string;
    }
  }
}

export {};
