/**
 * Sandbox Service
 *
 * Manages Vercel Sandbox instances for the App Builder.
 * Handles sandbox creation, reconnection, and lifecycle management.
 *
 * NOTE: AI code execution has been moved to app-builder-ai-sdk.ts
 * This service focuses on sandbox infrastructure only.
 */

import { logger } from "@/lib/utils/logger";

// Import shared utilities from the sandbox module
import {
  type SandboxInstance,
  type SandboxProgress,
  type SandboxConfig,
  type SandboxSessionData,
  readFileViaSh,
  writeFileViaSh,
  writeFilesViaSh,
  mkDirViaSh,
  installDependencies,
  waitForDevServer,
} from "./sandbox/index";

// Import snapshot service for faster sandbox creation
import {
  getValidSnapshot,
  recordSnapshotUsage,
  DEFAULT_TEMPLATE_KEY,
  isSnapshotsEnabled,
} from "./sandbox-snapshots";

// Re-export types for consumers
export type {
  SandboxInstance,
  SandboxProgress,
  SandboxConfig,
  SandboxSessionData,
};

// ============================================================================
// SDK Templates (Fallback for templates without built-in SDK)
// ============================================================================

const ELIZA_SDK_FILE = `const apiKey = process.env.NEXT_PUBLIC_ELIZA_API_KEY || '';
const apiBase = process.env.NEXT_PUBLIC_ELIZA_API_URL || 'https://www.elizacloud.ai';
const appId = process.env.NEXT_PUBLIC_ELIZA_APP_ID || '';

interface ChatMessage { role: string; content: string; }

const trackedPaths = new Set<string>();

export async function trackPageView(pathname?: string) {
  if (typeof window === 'undefined') return;
  const path = pathname || window.location.pathname;
  if (trackedPaths.has(path)) return;
  trackedPaths.add(path);
  try {
    const payload = {
      app_id: appId,
      page_url: window.location.href,
      pathname: path,
      referrer: document.referrer,
      screen_width: window.screen.width,
      screen_height: window.screen.height,
      ...(apiKey ? { api_key: apiKey } : {}),
    };
    const url = \`\${apiBase}/api/v1/track/pageview\`;
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    if (navigator.sendBeacon) navigator.sendBeacon(url, blob);
    else fetch(url, { method: 'POST', body: blob, keepalive: true }).catch(() => {});
  } catch {}
}

export async function chat(messages: ChatMessage[], model = 'gpt-4o') {
  const res = await fetch(\`\${apiBase}/api/v1/chat/completions\`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
    body: JSON.stringify({ messages, model }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function* chatStream(messages: ChatMessage[], model = 'gpt-4o') {
  const res = await fetch(\`\${apiBase}/api/v1/chat/completions\`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
    body: JSON.stringify({ messages, model, stream: true }),
  });
  const reader = res.body?.getReader();
  const decoder = new TextDecoder();
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const line of decoder.decode(value).split('\\n')) {
      if (line.startsWith('data: ') && !line.includes('[DONE]')) {
        try { yield JSON.parse(line.slice(6)); } catch {}
      }
    }
  }
}

export async function generateImage(prompt: string, options?: { model?: string; width?: number; height?: number }) {
  const res = await fetch(\`\${apiBase}/api/v1/generate-image\`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
    body: JSON.stringify({ prompt, ...options }),
  });
  return res.json();
}

export async function generateVideo(prompt: string, options?: { model?: string; duration?: number }) {
  const res = await fetch(\`\${apiBase}/api/v1/generate-video\`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
    body: JSON.stringify({ prompt, ...options }),
  });
  return res.json();
}

export async function getBalance() {
  const res = await fetch(\`\${apiBase}/api/v1/credits/balance\`, {
    headers: { 'X-Api-Key': apiKey },
  });
  return res.json();
}
`;

const ELIZA_HOOK_FILE = `'use client';
import { useState, useCallback, useEffect } from 'react';
import { usePathname } from 'next/navigation';

type ChatMessage = { role: string; content: string };

export function useChat() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = useCallback(async (messages: ChatMessage[]) => {
    setLoading(true);
    setError(null);
    try {
      const { chat } = await import('@/lib/eliza');
      return await chat(messages);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  return { send, loading, error };
}

export function useChatStream() {
  const [loading, setLoading] = useState(false);

  const stream = useCallback(async function* (messages: ChatMessage[]) {
    setLoading(true);
    try {
      const { chatStream } = await import('@/lib/eliza');
      yield* chatStream(messages);
    } finally {
      setLoading(false);
    }
  }, []);

  return { stream, loading };
}

export function usePageTracking() {
  const pathname = usePathname();

  useEffect(() => {
    const track = async () => {
      try {
        const { trackPageView } = await import('@/lib/eliza');
        trackPageView(pathname);
      } catch {
        // Silent fail for analytics
      }
    };
    track();
  }, [pathname]);
}
`;

const ELIZA_ANALYTICS_COMPONENT = `'use client';
import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { trackPageView } from '@/lib/eliza';

export function ElizaAnalytics() {
  const pathname = usePathname();

  useEffect(() => {
    trackPageView(pathname);
  }, [pathname]);

  return null;
}
`;

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_TEMPLATE_URL =
  "https://github.com/eliza-cloud-apps/cloud-apps-template.git";
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

// ============================================================================
// Global Sandbox Instance Management
// ============================================================================

declare global {
  var __sandboxInstances: Map<string, SandboxInstance> | undefined;
}

const getActiveSandboxes = (): Map<string, SandboxInstance> => {
  if (!global.__sandboxInstances) {
    global.__sandboxInstances = new Map<string, SandboxInstance>();
  }
  return global.__sandboxInstances;
};

// ============================================================================
// Helper Functions
// ============================================================================

function getSandboxCredentials() {
  const hasOIDC = !!process.env.VERCEL_OIDC_TOKEN;
  const teamId = process.env.VERCEL_TEAM_ID;
  const projectId = process.env.VERCEL_PROJECT_ID;
  const token = process.env.VERCEL_TOKEN;
  const hasAccessToken = !!(teamId && projectId && token);
  return { hasOIDC, hasAccessToken, teamId, projectId, token };
}

function extractSandboxIdFromUrl(url: string): string {
  const hostname = new URL(url).hostname;
  return hostname.split(".")[0] || `sandbox-${crypto.randomUUID().slice(0, 8)}`;
}

// ============================================================================
// SandboxService Class
// ============================================================================

export class SandboxService {
  /**
   * Create a new sandbox instance.
   */
  async create(config: SandboxConfig = {}): Promise<SandboxSessionData> {
    const {
      templateUrl = DEFAULT_TEMPLATE_URL,
      timeout = DEFAULT_TIMEOUT_MS,
      vcpus = 4,
      ports = [3000],
      env = {},
      onProgress,
    } = config;

    // Extract snapshot-related config options
    const {
      snapshotId: configSnapshotId,
      templateKey = DEFAULT_TEMPLATE_KEY,
      skipSnapshotLookup = false,
    } = config;

    // Try to find an existing snapshot if not skipped and no explicit snapshot provided
    let useSnapshotId = configSnapshotId;
    let createdFromSnapshot = false;

    if (!skipSnapshotLookup && !useSnapshotId && isSnapshotsEnabled()) {
      const existingSnapshot = await getValidSnapshot(templateKey);
      if (existingSnapshot) {
        useSnapshotId = existingSnapshot.snapshotId;
        logger.info("Found valid snapshot for template", {
          templateKey,
          snapshotId: useSnapshotId,
          expiresAt: existingSnapshot.expiresAt,
        });
      }
    }

    const mergedEnv = { ...env };
    const creds = getSandboxCredentials();

    if (!creds.hasOIDC && !creds.hasAccessToken) {
      throw new Error(
        "Vercel Sandbox credentials not configured. Run 'vercel env pull' to get OIDC token, or set VERCEL_TOKEN, VERCEL_TEAM_ID, and VERCEL_PROJECT_ID.",
      );
    }

    const { Sandbox } = await import("@vercel/sandbox");

    logger.info("Creating sandbox", { templateUrl, vcpus });
    onProgress?.({ step: "creating", message: "Creating sandbox instance..." });

    // Configure sandbox source: use snapshot if available, otherwise git
    const createOptions: Record<string, unknown> = {
      source: useSnapshotId
        ? { type: "snapshot", snapshotId: useSnapshotId }
        : { url: templateUrl, type: "git" },
      resources: { vcpus },
      timeout,
      ports,
      runtime: "node24",
    };

    if (creds.hasAccessToken) {
      createOptions.teamId = creds.teamId;
      createOptions.projectId = creds.projectId;
      createOptions.token = creds.token;
    }

    let sandbox: SandboxInstance;
    try {
      sandbox = (await Sandbox.create(createOptions)) as SandboxInstance;
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      const apiError = error as {
        json?: unknown;
        text?: string;
        response?: { status?: number };
      };
      const jsonDetails = apiError.json
        ? JSON.stringify(apiError.json, null, 2)
        : undefined;
      const textDetails = apiError.text;
      const statusCode = apiError.response?.status;

      logger.error("Sandbox creation failed", {
        error: errorMessage,
        statusCode,
        jsonDetails,
        textDetails,
        createOptions: {
          ...createOptions,
          token: createOptions.token ? "[REDACTED]" : undefined,
        },
        stack: error instanceof Error ? error.stack : undefined,
      });

      let detailedMessage = errorMessage;
      if (jsonDetails) {
        detailedMessage += `\n\nVercel API Response:\n${jsonDetails}`;
      } else if (textDetails) {
        detailedMessage += `\n\nVercel API Response:\n${textDetails}`;
      }

      if (errorMessage.includes("OIDC")) {
        throw new Error(
          `OIDC token expired or invalid. Run 'vercel env pull' to refresh it. Original error: ${detailedMessage}`,
        );
      }

      if (
        errorMessage.includes("400") ||
        errorMessage.includes("Bad Request") ||
        statusCode === 400
      ) {
        throw new Error(
          `Vercel Sandbox creation failed (400 Bad Request).\n\n` +
            `Possible causes:\n` +
            `1. Concurrent sandbox limit reached - wait for existing sandboxes to expire\n` +
            `2. Template URL is invalid or inaccessible\n` +
            `3. Account sandbox quota exceeded\n` +
            `4. Invalid configuration parameters\n\n` +
            `Details: ${detailedMessage}`,
        );
      }

      if (
        errorMessage.includes("429") ||
        errorMessage.includes("rate limit") ||
        statusCode === 429
      ) {
        throw new Error(
          `Vercel Sandbox rate limit exceeded. Wait a few minutes and try again.\n\nDetails: ${detailedMessage}`,
        );
      }

      throw new Error(`Sandbox creation failed: ${detailedMessage}`);
    }

    const devServerUrl = sandbox.domain(3000);
    const sandboxId = sandbox.id ?? extractSandboxIdFromUrl(devServerUrl);

    logger.info("Sandbox created", { sandboxId, devServerUrl });
    getActiveSandboxes().set(sandboxId, sandbox);
    onProgress?.({ step: "creating", message: "Sandbox instance created" });

    // Track if created from snapshot
    if (useSnapshotId) {
      createdFromSnapshot = true;
      await recordSnapshotUsage(useSnapshotId);
      logger.info("Sandbox created from snapshot", { sandboxId, snapshotId: useSnapshotId });
    }

    // Skip bun install and dependencies if created from snapshot (already included)
    if (!createdFromSnapshot) {
    // Install bun runtime
    logger.info("Installing bun runtime", { sandboxId });
    onProgress?.({ step: "installing", message: "Installing bun runtime..." });

    const bunInstall = await sandbox.runCommand({
      cmd: "npm",
      args: ["install", "-g", "bun"],
    });

    if (bunInstall.exitCode !== 0) {
      logger.warn(
        "Failed to install bun globally, will fall back to pnpm/npm",
        {
          sandboxId,
          stderr: await bunInstall.stderr(),
        },
      );
    } else {
      logger.info("Bun installed successfully", { sandboxId });
    }

    // Install dependencies
    logger.info("Installing dependencies", { sandboxId });
    onProgress?.({ step: "installing", message: "Installing dependencies..." });

    const installResult = await installDependencies(sandbox);
    if (installResult.includes("Failed")) {
      throw new Error(installResult);
    }

    onProgress?.({ step: "installing", message: "Dependencies installed" });
    } else {
      logger.info("Skipping bun install and dependencies (created from snapshot)", { sandboxId });
      onProgress?.({ step: "installing", message: "Using pre-installed dependencies from snapshot" });
    }

    // SDK injection logic
    const markerCheck = await sandbox.runCommand({
      cmd: "test",
      args: ["-f", ".eliza-sdk-ready"],
    });

    if (markerCheck.exitCode === 0) {
      logger.info("SDK marker found, skipping all SDK injection", {
        sandboxId,
      });
      onProgress?.({ step: "installing", message: "SDK pre-configured" });
    } else {
      const srcCheck = await sandbox.runCommand({
        cmd: "test",
        args: ["-d", "src"],
      });
      const useSrc = srcCheck.exitCode === 0;
      const libPath = useSrc ? "src/lib" : "lib";
      const hooksPath = useSrc ? "src/hooks" : "hooks";
      const componentsPath = useSrc ? "src/components" : "components";

      const sdkCheck = await sandbox.runCommand({
        cmd: "test",
        args: ["-f", `${libPath}/eliza.ts`],
      });
      const sdkExists = sdkCheck.exitCode === 0;

      if (sdkExists) {
        logger.info("SDK files already exist in template, skipping injection", {
          sandboxId,
          libPath,
        });
        onProgress?.({ step: "installing", message: "SDK already configured" });
      } else {
        logger.info("SDK files not found, injecting fallback SDK", {
          sandboxId,
        });
        onProgress?.({ step: "installing", message: "Setting up SDK..." });

        // Create directories using native SDK method
        await Promise.all([
          mkDirViaSh(sandbox, libPath),
          mkDirViaSh(sandbox, hooksPath),
          mkDirViaSh(sandbox, componentsPath),
        ]);

        // Batch write all SDK files at once using native SDK method
        const { written, failed } = await writeFilesViaSh(sandbox, [
          { path: `${libPath}/eliza.ts`, content: ELIZA_SDK_FILE },
          { path: `${hooksPath}/use-eliza.ts`, content: ELIZA_HOOK_FILE },
          {
            path: `${componentsPath}/eliza-analytics.tsx`,
            content: ELIZA_ANALYTICS_COMPONENT,
          },
        ]);

        if (failed.length > 0) {
          logger.warn("Some SDK files failed to write", { sandboxId, failed });
        }

        logger.info("SDK files injected", { sandboxId, written });

        const layoutPath = useSrc ? "src/app/layout.tsx" : "app/layout.tsx";
        const layoutContent = await readFileViaSh(sandbox, layoutPath);
        if (
          layoutContent &&
          !layoutContent.includes("ElizaAnalytics") &&
          !layoutContent.includes("ElizaProvider")
        ) {
          const analyticsImport = `import { ElizaAnalytics } from '@/components/eliza-analytics';\nimport { Analytics } from '@vercel/analytics/next';\n`;
          let updatedLayout = analyticsImport + layoutContent;

          const bodyMatch = updatedLayout.match(/<body[^>]*>/);
          if (bodyMatch) {
            const bodyTag = bodyMatch[0];
            updatedLayout = updatedLayout.replace(
              bodyTag,
              `${bodyTag}\n        <ElizaAnalytics />\n        <Analytics />`,
            );
          }

          await writeFileViaSh(sandbox, layoutPath, updatedLayout);
          logger.info("Injected analytics components into layout.tsx", {
            sandboxId,
            layoutPath,
          });
        }
      }
    }

    // Configure environment variables
    const isLocalDev =
      process.env.NEXT_PUBLIC_APP_URL?.includes("localhost") ||
      process.env.NEXT_PUBLIC_APP_URL?.includes("127.0.0.1");

    const elizaApiUrl =
      process.env.ELIZA_API_URL ||
      process.env.NEXT_PUBLIC_ELIZA_API_URL ||
      config.env?.NEXT_PUBLIC_ELIZA_API_URL;

    const elizaProxyUrl =
      config.env?.NEXT_PUBLIC_ELIZA_PROXY_URL ||
      process.env.NEXT_PUBLIC_ELIZA_PROXY_URL;

    if (elizaProxyUrl) {
      mergedEnv.NEXT_PUBLIC_ELIZA_PROXY_URL = elizaProxyUrl;
      logger.info("Using postMessage proxy bridge for API calls", {
        sandboxId,
        proxyUrl: elizaProxyUrl,
      });
    } else if (elizaApiUrl) {
      mergedEnv.NEXT_PUBLIC_ELIZA_API_URL = elizaApiUrl;
      logger.info("Using direct Eliza API URL", {
        sandboxId,
        apiUrl: elizaApiUrl,
      });
    } else if (isLocalDev && !config.env?.NEXT_PUBLIC_ELIZA_API_URL) {
      const localServerUrl =
        process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
      mergedEnv.NEXT_PUBLIC_ELIZA_PROXY_URL = localServerUrl;
      logger.info("Local dev: defaulting to postMessage proxy bridge", {
        sandboxId,
        proxyUrl: localServerUrl,
      });
    }

    if (Object.keys(mergedEnv).length > 0) {
      logger.info("Writing .env.local", {
        sandboxId,
        envCount: Object.keys(mergedEnv).length,
      });
      const envContent = Object.entries(mergedEnv)
        .map(([key, value]) => `${key}=${value}`)
        .join("\n");

      // Use native SDK method for writing env file
      // Note: .env.local is a special file that bypasses normal path validation
      try {
        if (typeof sandbox.writeFiles === "function") {
          await sandbox.writeFiles([
            { path: ".env.local", content: Buffer.from(envContent, "utf-8") },
          ]);
        } else {
          // Fallback to shell command
          const envBase64 = Buffer.from(envContent, "utf-8").toString("base64");
          await sandbox.runCommand({
            cmd: "sh",
            args: ["-c", `echo '${envBase64}' | base64 -d > .env.local`],
          });
        }
      } catch {
        // Fallback to shell command if native method fails
        const envBase64 = Buffer.from(envContent, "utf-8").toString("base64");
        await sandbox.runCommand({
          cmd: "sh",
          args: ["-c", `echo '${envBase64}' | base64 -d > .env.local`],
        });
      }
    }

    // Start dev server
    logger.info("Starting dev server", {
      sandboxId,
      envVarCount: Object.keys(mergedEnv).length,
    });
    onProgress?.({
      step: "starting",
      message: "Starting dev server with Turbopack...",
    });

    await sandbox.runCommand({
      cmd: "sh",
      args: [
        "-c",
        "bun dev 2>&1 | tee /tmp/next-dev.log || pnpm dev 2>&1 | tee /tmp/next-dev.log &",
      ],
      detached: true,
      env: mergedEnv,
    });

    await waitForDevServer(sandbox, 3000);

    logger.info("Sandbox ready", { sandboxId, devServerUrl });
    onProgress?.({ step: "ready", message: "Sandbox is ready!" });

    return {
      sandboxId,
      sandboxUrl: devServerUrl,
      status: "ready",
      devServerUrl,
      startedAt: new Date(),
      createdFromSnapshot,
    };
  }

  // ============================================================================
  // File Operations
  // ============================================================================

  async readFile(sandboxId: string, path: string): Promise<string> {
    const sandbox = getActiveSandboxes().get(sandboxId);
    if (!sandbox) throw new Error(`Sandbox ${sandboxId} not found`);
    const content = await readFileViaSh(sandbox, path);
    if (!content) throw new Error(`File not found: ${path}`);
    return content;
  }

  async writeFile(
    sandboxId: string,
    path: string,
    content: string,
  ): Promise<void> {
    const sandbox = getActiveSandboxes().get(sandboxId);
    if (!sandbox) throw new Error(`Sandbox ${sandboxId} not found`);
    await writeFileViaSh(sandbox, path, content);
  }

  async listFiles(sandboxId: string, path: string): Promise<string[]> {
    const sandbox = getActiveSandboxes().get(sandboxId);
    if (!sandbox) throw new Error(`Sandbox ${sandboxId} not found`);
    const { listFilesViaSh } = await import("./sandbox/index");
    return await listFilesViaSh(sandbox, path);
  }

  // ============================================================================
  // Build Operations
  // ============================================================================

  async checkBuild(sandboxId: string): Promise<string> {
    const sandbox = getActiveSandboxes().get(sandboxId);
    if (!sandbox) throw new Error(`Sandbox ${sandboxId} not found`);
    const { checkBuild } = await import("./sandbox/index");
    return await checkBuild(sandbox);
  }

  // ============================================================================
  // Package Operations
  // ============================================================================

  async installPackages(
    sandboxId: string,
    packages: string[],
  ): Promise<string> {
    const sandbox = getActiveSandboxes().get(sandboxId);
    if (!sandbox) throw new Error(`Sandbox ${sandboxId} not found`);
    const { installPackages } = await import("./sandbox/index");
    return await installPackages(sandbox, packages);
  }

  async installDependencies(sandboxId: string): Promise<string> {
    const sandbox = getActiveSandboxes().get(sandboxId);
    if (!sandbox) throw new Error(`Sandbox ${sandboxId} not found`);
    return await installDependencies(sandbox);
  }

  installDependenciesBackground(sandboxId: string): void {
    const sandbox = getActiveSandboxes().get(sandboxId);
    if (!sandbox) {
      logger.warn("Cannot install dependencies - sandbox not found", {
        sandboxId,
      });
      return;
    }

    logger.info("Starting background dependency install", { sandboxId });

    sandbox
      .runCommand({
        cmd: "sh",
        args: [
          "-c",
          "bun install --frozen-lockfile 2>&1 | tee /tmp/install.log || bun install 2>&1 | tee -a /tmp/install.log || pnpm install 2>&1 | tee -a /tmp/install.log &",
        ],
        detached: true,
      })
      .then(() => {
        logger.info("Background install command dispatched", { sandboxId });
      })
      .catch((err) => {
        logger.warn("Background install dispatch failed", {
          sandboxId,
          error: err,
        });
      });
  }

  async installDependenciesAndRestart(
    sandboxId: string,
    onProgress?: (progress: SandboxProgress) => void,
  ): Promise<void> {
    const sandbox = getActiveSandboxes().get(sandboxId);
    if (!sandbox) {
      throw new Error(`Sandbox ${sandboxId} not found`);
    }

    logger.info("Starting dependency install and dev server restart", {
      sandboxId,
    });

    onProgress?.({ step: "installing", message: "Stopping dev server..." });
    await sandbox.runCommand({
      cmd: "sh",
      args: [
        "-c",
        "pkill -f 'next dev' 2>/dev/null || true; pkill -f 'node.*next' 2>/dev/null || true",
      ],
    });
    await new Promise((r) => setTimeout(r, 1000));

    onProgress?.({ step: "installing", message: "Installing dependencies..." });
    const installResult = await installDependencies(sandbox);
    logger.info("Dependencies installed for restore", {
      sandboxId,
      result: installResult,
    });

    onProgress?.({
      step: "starting",
      message: "Starting dev server with Turbopack...",
    });
    await sandbox.runCommand({
      cmd: "sh",
      args: [
        "-c",
        "bun dev 2>&1 | tee /tmp/next-dev.log || pnpm dev 2>&1 | tee /tmp/next-dev.log &",
      ],
      detached: true,
    });

    await waitForDevServer(sandbox, 3000);
    logger.info("Dev server restarted after dependency install", { sandboxId });
    onProgress?.({ step: "ready", message: "Dev server ready!" });
  }

  // ============================================================================
  // Lifecycle Operations
  // ============================================================================

  async extendTimeout(sandboxId: string, durationMs: number): Promise<void> {
    const sandbox = getActiveSandboxes().get(sandboxId);
    if (!sandbox) throw new Error(`Sandbox ${sandboxId} not found`);
    await sandbox.extendTimeout(durationMs);
  }

  async getLogs(sandboxId: string, tail: number = 50): Promise<string[]> {
    const sandbox = getActiveSandboxes().get(sandboxId);
    if (!sandbox) return [];
    const logsResult = await sandbox.runCommand({
      cmd: "sh",
      args: ["-c", `tail -${tail} /tmp/next-dev.log 2>/dev/null || echo ""`],
    });
    const stdout = await logsResult.stdout();
    return stdout.split("\n").filter((l: string) => l.trim());
  }

  async stop(sandboxId: string): Promise<void> {
    const sandbox = getActiveSandboxes().get(sandboxId);
    if (!sandbox) return;
    await sandbox.stop();
    getActiveSandboxes().delete(sandboxId);
    logger.info("Sandbox stopped", { sandboxId });
  }

  getStatus(sandboxId: string): "running" | "stopped" | "unknown" {
    return getActiveSandboxes().has(sandboxId) ? "running" : "unknown";
  }

  getSandboxInstance(sandboxId: string): SandboxInstance | undefined {
    return getActiveSandboxes().get(sandboxId);
  }

  getActiveSandboxIds(): string[] {
    return Array.from(getActiveSandboxes().keys());
  }

  // ============================================================================
  // Reconnection
  // ============================================================================

  async tryReconnect(
    sandboxId: string,
    sandboxUrl: string,
    options: {
      onProgress?: (progress: SandboxProgress) => void;
      timeoutMs?: number;
    } = {},
  ): Promise<SandboxSessionData | null> {
    const { onProgress, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
    const creds = getSandboxCredentials();

    if (!creds.hasOIDC && !creds.hasAccessToken) {
      logger.warn("Cannot reconnect: Vercel credentials not configured");
      return null;
    }

    logger.info("Attempting to reconnect to sandbox", {
      sandboxId,
      sandboxUrl,
    });
    onProgress?.({
      step: "restoring",
      message: "Reconnecting to existing sandbox...",
    });

    try {
      const existingSandbox = getActiveSandboxes().get(sandboxId);
      if (existingSandbox) {
        try {
          const pingResult = await existingSandbox.runCommand({
            cmd: "echo",
            args: ["ping"],
          });
          if (pingResult.exitCode === 0) {
            logger.info("Using existing local sandbox reference", {
              sandboxId,
            });

            const healthCheck = await existingSandbox.runCommand({
              cmd: "curl",
              args: [
                "-s",
                "-o",
                "/dev/null",
                "-w",
                "%{http_code}",
                "-m",
                "5",
                "http://localhost:3000",
              ],
            });

            const statusCode = await healthCheck.stdout();
            if (statusCode === "200" || statusCode === "304") {
              try {
                await existingSandbox.extendTimeout(timeoutMs);
              } catch {
                // Ignore extend timeout errors
              }

              onProgress?.({
                step: "ready",
                message: "Reconnected to sandbox!",
              });
              return {
                sandboxId,
                sandboxUrl,
                status: "ready",
                devServerUrl: sandboxUrl,
                startedAt: new Date(),
              };
            }

            onProgress?.({
              step: "starting",
              message: "Restarting dev server...",
            });
            await existingSandbox.runCommand({
              cmd: "sh",
              args: ["-c", "pkill -f 'next dev' 2>/dev/null || true"],
            });
            await new Promise((r) => setTimeout(r, 500));

            await existingSandbox.runCommand({
              cmd: "sh",
              args: [
                "-c",
                "bun dev 2>&1 | tee /tmp/next-dev.log || pnpm dev 2>&1 | tee /tmp/next-dev.log &",
              ],
              detached: true,
            });

            await waitForDevServer(existingSandbox, 3000);

            onProgress?.({ step: "ready", message: "Reconnected to sandbox!" });
            return {
              sandboxId,
              sandboxUrl,
              status: "ready",
              devServerUrl: sandboxUrl,
              startedAt: new Date(),
            };
          }
        } catch {
          getActiveSandboxes().delete(sandboxId);
        }
      }

      const SandboxModule = await import("@vercel/sandbox");
      const Sandbox = SandboxModule.Sandbox || SandboxModule.default;

      const connectOptions: Record<string, unknown> = { id: sandboxId };

      if (creds.hasAccessToken) {
        connectOptions.teamId = creds.teamId;
        connectOptions.projectId = creds.projectId;
        connectOptions.token = creds.token;
      }

      let sandbox: SandboxInstance | null = null;

      const SandboxClass = Sandbox as unknown as {
        connect?: (opts: unknown) => Promise<SandboxInstance>;
        get?: (opts: unknown) => Promise<SandboxInstance>;
        reconnect?: (opts: unknown) => Promise<SandboxInstance>;
      };

      if (typeof SandboxClass.connect === "function") {
        sandbox = await SandboxClass.connect(connectOptions);
      } else if (typeof SandboxClass.get === "function") {
        sandbox = await SandboxClass.get(connectOptions);
      } else if (typeof SandboxClass.reconnect === "function") {
        sandbox = await SandboxClass.reconnect(connectOptions);
      }

      if (!sandbox) {
        logger.info("Sandbox reconnection not supported or sandbox not found", {
          sandboxId,
        });
        return null;
      }

      const healthCheck = await sandbox.runCommand({
        cmd: "curl",
        args: [
          "-s",
          "-o",
          "/dev/null",
          "-w",
          "%{http_code}",
          "-m",
          "5",
          "http://localhost:3000",
        ],
      });

      const statusCode = await healthCheck.stdout();
      const isHealthy = statusCode === "200" || statusCode === "304";

      if (!isHealthy) {
        logger.info(
          "Sandbox reconnected but dev server not responding, attempting restart",
          {
            sandboxId,
            statusCode,
          },
        );

        onProgress?.({ step: "starting", message: "Restarting dev server..." });
        await sandbox.runCommand({
          cmd: "sh",
          args: ["-c", "pkill -f 'next dev' 2>/dev/null || true"],
        });
        await new Promise((r) => setTimeout(r, 500));

        await sandbox.runCommand({
          cmd: "sh",
          args: [
            "-c",
            "bun dev 2>&1 | tee /tmp/next-dev.log || pnpm dev 2>&1 | tee /tmp/next-dev.log &",
          ],
          detached: true,
        });

        await waitForDevServer(sandbox, 3000);
      }

      try {
        await sandbox.extendTimeout(timeoutMs);
      } catch (extendError) {
        logger.warn("Failed to extend sandbox timeout", {
          sandboxId,
          error: extendError instanceof Error ? extendError.message : "Unknown",
        });
      }

      getActiveSandboxes().set(sandboxId, sandbox);

      logger.info("Successfully reconnected to sandbox", {
        sandboxId,
        sandboxUrl,
      });
      onProgress?.({ step: "ready", message: "Reconnected to sandbox!" });

      return {
        sandboxId,
        sandboxUrl,
        status: "ready",
        devServerUrl: sandboxUrl,
        startedAt: new Date(),
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      logger.info("Sandbox reconnection failed", {
        sandboxId,
        error: errorMessage,
      });
      return null;
    }
  }

  async isSandboxAlive(sandboxId: string): Promise<boolean> {
    const sandbox = getActiveSandboxes().get(sandboxId);

    if (sandbox) {
      try {
        const result = await sandbox.runCommand({
          cmd: "echo",
          args: ["ping"],
        });
        return result.exitCode === 0;
      } catch {
        getActiveSandboxes().delete(sandboxId);
        return false;
      }
    }

    return false;
  }


  // ============================================================================
  // Snapshot Operations
  // ============================================================================

  /**
   * Create a snapshot from a running sandbox for faster future startups.
   * NOTE: This will STOP the sandbox! The sandbox becomes unreachable after snapshotting.
   * 
   * @param sandboxId - The sandbox to snapshot
   * @param options - Options for the snapshot
   * @returns The snapshot ID if successful, null otherwise
   */
  async createSnapshot(
    sandboxId: string,
    options: {
      templateKey?: string;
      githubRepo?: string;
    } = {},
  ): Promise<string | null> {
    const sandbox = getActiveSandboxes().get(sandboxId);
    if (!sandbox) {
      logger.warn("Cannot create snapshot: sandbox not found", { sandboxId });
      return null;
    }

    // Stop the dev server before snapshotting for a clean state
    logger.info("Stopping dev server before snapshot", { sandboxId });
    await sandbox.runCommand({
      cmd: "sh",
      args: ["-c", "pkill -f 'next dev' 2>/dev/null || true; pkill -f 'node.*next' 2>/dev/null || true"],
    });
    await new Promise((r) => setTimeout(r, 2000));

    // Import snapshot service and create snapshot
    const { createSnapshotFromSandbox } = await import("./sandbox-snapshots");
    
    const snapshotSandbox = sandbox as unknown as {
      sandboxId: string;
      snapshot: () => Promise<{ snapshotId: string }>;
    };

    const result = await createSnapshotFromSandbox(snapshotSandbox, {
      templateKey: options.templateKey || DEFAULT_TEMPLATE_KEY,
      githubRepo: options.githubRepo,
    });

    if (result) {
      // Remove from active sandboxes (sandbox is stopped after snapshot)
      getActiveSandboxes().delete(sandboxId);
      logger.info("Snapshot created and sandbox stopped", {
        sandboxId,
        snapshotId: result.snapshot_id,
      });
      return result.snapshot_id;
    }

    return null;
  }

  static isConfigured(): boolean {
    const creds = getSandboxCredentials();
    return creds.hasOIDC || creds.hasAccessToken;
  }
}

export const sandboxService = new SandboxService();
