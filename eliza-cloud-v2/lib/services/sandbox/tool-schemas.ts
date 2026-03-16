/**
 * Tool schemas for AI SDK tools used in app building.
 */

import { z } from "zod";

/**
 * Zod schemas for tool parameters.
 * Used by AI SDK to validate and describe tool inputs.
 */
export const toolSchemas = {
  install_packages: z.object({
    packages: z.array(z.string()).describe("Package names to install"),
  }),
  write_file: z.object({
    path: z.string().describe("File path (e.g., 'src/app/page.tsx')"),
    content: z.string().describe("Complete file content"),
  }),
  read_file: z.object({
    path: z.string().describe("File path to read"),
  }),
  check_build: z.object({}).describe("Check build status"),
  list_files: z.object({
    path: z.string().default(".").describe("Directory path"),
  }),
  run_command: z.object({
    command: z
      .string()
      .describe(
        "Command to run (drizzle-kit commands auto-inject DATABASE_URL)",
      ),
  }),
};

export type ToolName = keyof typeof toolSchemas;
