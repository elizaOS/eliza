#!/usr/bin/env bun
/**
 * Development wrapper — starts Next.js and the local cron simulator.
 */

// @ts-expect-error - bun global is available in bun runtime
import { $ } from "bun";

await $`concurrently --kill-others-on-fail -n "next,cron" -c "cyan,magenta" "cd apps/web && bun run dev" "bun run scripts/local-cron-simulator.ts"`.nothrow();
