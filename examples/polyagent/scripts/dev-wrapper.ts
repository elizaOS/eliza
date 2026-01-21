#!/usr/bin/env bun

/**
 * Development wrapper that conditionally starts Hardhat based on environment
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error - bun global is available in bun runtime
import { $ } from "bun";
import { detectEnvironment } from "../packages/contracts/src/deployment/env-detection";

// Load .env file to detect environment
const envPath = join(process.cwd(), ".env");
if (existsSync(envPath)) {
  const envContent = readFileSync(envPath, "utf-8");
  // Parse .env file and set environment variables
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) {
      const [key, ...valueParts] = trimmed.split("=");
      if (key && valueParts.length > 0) {
        const value = valueParts.join("=").replace(/^["']|["']$/g, "");
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
    }
  }
}

const detectedEnv = detectEnvironment();
const isLocalnet = detectedEnv === "localnet";

if (isLocalnet) {
  // Start Hardhat, deploy, Next.js, and cron
  // Note: Using "cd apps/web && bun run dev" instead of "bunx turbo dev" to avoid WSL glob pattern issues
  // Note: Using --kill-others-on-fail so only failures kill other processes (deploy exits successfully after completion)
  await $`concurrently --kill-others-on-fail -n "hardhat,deploy,next,cron" -c "yellow,blue,cyan,magenta" "cd packages/contracts && bunx hardhat node --hostname 0.0.0.0" "bun run scripts/wait-for-hardhat-and-deploy.ts" "cd apps/web && bun run dev" "bun run scripts/local-cron-simulator.ts"`.nothrow();
} else {
  // Start Next.js and cron only (no Hardhat/deploy)
  // Note: Using "cd apps/web && bun run dev" instead of "bunx turbo dev" to avoid WSL glob pattern issues
  await $`concurrently --kill-others-on-fail -n "next,cron" -c "cyan,magenta" "cd apps/web && bun run dev" "bun run scripts/local-cron-simulator.ts"`.nothrow();
}
