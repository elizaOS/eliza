import { sandboxService, type SandboxProgress } from "./sandbox";
import { appBuilderAISDK } from "./app-builder-ai-sdk";
import {
  buildFullAppPrompt,
  getExamplePrompts,
  type FullAppTemplateType,
} from "@/lib/fragments/prompt";
import { logger } from "@/lib/utils/logger";
import { dbRead, dbWrite } from "@/db/client";
import {
  appSandboxSessions,
  appBuilderPrompts,
  appTemplates,
  type AppSandboxSession,
  type NewAppSandboxSession,
  type NewAppBuilderPrompt,
} from "@/db/schemas/app-sandboxes";
import { eq, desc, and } from "drizzle-orm";
import { appsService, AppNameConflictError } from "./apps";
import { appFactoryService } from "./app-factory";
import { gitSyncService } from "./git-sync";
import { githubReposService } from "./github-repos";
import { userDatabaseService } from "./user-database";
import { getDetailedAnalysis } from "./stateful-detection";

const EXAMPLE_PROMPTS = {
  chat: getExamplePrompts("chat"),
  "agent-dashboard": getExamplePrompts("agent-dashboard"),
  "landing-page": getExamplePrompts("landing-page"),
  analytics: getExamplePrompts("analytics"),
  blank: getExamplePrompts("blank"),
  "mcp-service": getExamplePrompts("mcp-service"),
  "a2a-agent": getExamplePrompts("a2a-agent"),
  "saas-starter": getExamplePrompts("saas-starter"),
  "ai-tool": getExamplePrompts("ai-tool"),
};

export interface BuilderSessionConfig {
  userId: string;
  organizationId: string;
  appId?: string;
  appName?: string;
  appDescription?: string;
  initialPrompt?: string;
  templateType?:
    | "chat"
    | "agent-dashboard"
    | "landing-page"
    | "analytics"
    | "blank"
    | "mcp-service"
    | "a2a-agent"
    | "saas-starter"
    | "ai-tool";
  includeMonetization?: boolean;
  includeAnalytics?: boolean;
  /** User explicitly requested persistent storage (PostgreSQL database) */
  includePersistentStorage?: boolean;
  linkedAgentIds?: string[];
  onProgress?: (progress: SandboxProgress) => void;
  onSandboxReady?: (session: BuilderSession) => void;
  onToolUse?: (tool: string, input: unknown, result: string) => void;
  onThinking?: (text: string) => void;
  abortSignal?: AbortSignal;
}

export type { SandboxProgress };

export interface BuilderSession {
  id: string;
  sandboxId: string;
  sandboxUrl: string;
  status: AppSandboxSession["status"];
  messages: Array<{
    role: "user" | "assistant" | "system";
    content: string;
    timestamp: string;
  }>;
  examplePrompts: string[];
  expiresAt: string | null;
  initialPromptResult?: PromptResult;
  appId?: string;
  githubRepo?: string | null;
  /** Whether this app has a provisioned database */
  hasDatabase?: boolean;
}

export interface PromptResult {
  success: boolean;
  output: string;
  reasoning?: string;
  filesAffected: string[];
  error?: string;
}

export class AIAppBuilderService {
  private async verifyOwnership(
    sessionId: string,
    userId: string,
  ): Promise<AppSandboxSession> {
    const session = await dbRead.query.appSandboxSessions.findFirst({
      where: eq(appSandboxSessions.id, sessionId),
    });

    if (!session) throw new Error("Session not found");
    if (session.user_id !== userId)
      throw new Error("Access denied: You don't own this session");

    return session;
  }

  async startSession(config: BuilderSessionConfig): Promise<BuilderSession> {
    const {
      userId,
      organizationId,
      appId: providedAppId,
      appName,
      appDescription,
      initialPrompt,
      templateType = "blank",
      includeMonetization = true,
      includeAnalytics = true,
      includePersistentStorage = false,
      linkedAgentIds,
      onProgress,
      onSandboxReady,
      onToolUse,
      onThinking,
      abortSignal,
    } = config;

    logger.info("Starting AI App Builder session", {
      userId,
      templateType,
      appName,
    });

    let appId = providedAppId;
    let appApiKey: string | undefined;
    let githubRepo: string | null = null;

    if (!appId && appName) {
      // Try to create app, but handle case where user already owns an app with this name
      // (can happen if previous sandbox creation failed after app was created)
      try {
        // Use AppFactoryService to create app WITH GitHub repo
        const result = await appFactoryService.createApp(
          {
            name: appName,
            description:
              appDescription || `AI-built app (template: ${templateType})`,
            organization_id: organizationId,
            created_by_user_id: userId,
            app_url: "https://placeholder.local",
            allowed_origins: ["*"],
          },
          {
            createGitHubRepo: true,
            repoPrivate: true,
            assignSubdomain: true,
          },
        );
        appId = result.app.id;
        appApiKey = result.apiKey;
        githubRepo = result.githubRepo || null;

        logger.info("Created app for AI builder session with GitHub repo", {
          appId,
          appName,
          githubRepo,
          githubRepoCreated: result.githubRepoCreated,
        });

        if (result.errors.length > 0) {
          logger.warn("App creation had warnings", { warnings: result.errors });
        }
      } catch (error) {
        // Check if this is a name conflict AND user owns an app with this name
        if (error instanceof AppNameConflictError) {
          // Generate the slug that would be created from this name
          const slug = appName
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .substring(0, 50);

          // Check if user's organization owns an app with this slug
          const existingApp = await appsService.getBySlug(slug);

          if (existingApp && existingApp.organization_id === organizationId) {
            // User owns this app - reuse it instead of failing
            logger.info(
              "Reusing existing app owned by user (previous session may have failed)",
              {
                appId: existingApp.id,
                appName,
                slug,
              },
            );

            appId = existingApp.id;
            appApiKey = await appsService.regenerateApiKey(appId);
            githubRepo = existingApp.github_repo || null;
          } else {
            // App exists but belongs to someone else - rethrow
            throw error;
          }
        } else {
          throw error;
        }
      }

      // Update app with linked agent IDs if provided
      if (linkedAgentIds && linkedAgentIds.length > 0 && appId) {
        await appsService.update(appId, {
          linked_character_ids: linkedAgentIds,
        });
        logger.info("Linked agents to app", {
          appId,
          agentCount: linkedAgentIds.length,
        });
      }
    } else if (appId) {
      appApiKey = await appsService.regenerateApiKey(appId);
      // Fetch existing app to get GitHub repo
      const existingApp = await appsService.getById(appId);
      githubRepo = existingApp?.github_repo || null;
      logger.info("Regenerated API key for existing app", {
        appId,
        githubRepo,
      });

      // Update linked agent IDs if provided for existing app
      if (linkedAgentIds && linkedAgentIds.length > 0) {
        await appsService.update(appId, {
          linked_character_ids: linkedAgentIds,
        });
        logger.info("Updated linked agents for existing app", {
          appId,
          agentCount: linkedAgentIds.length,
        });
      }
    }
    if (!appId) {
      throw new Error("App ID is required to start builder session");
    }

    // Determine template URL for sandbox creation
    let templateUrl: string | undefined;

    // Priority 1: If existing app has a GitHub repo, clone from that
    if (githubRepo) {
      const repoName = githubRepo.split("/").pop() || githubRepo;
      try {
        templateUrl = githubReposService.getAuthenticatedCloneUrl(repoName);
        logger.info("Using existing app GitHub repo as template", {
          appId,
          githubRepo,
        });
      } catch (error) {
        logger.warn(
          "Failed to get authenticated clone URL, falling back to template",
          {
            appId,
            githubRepo,
            error: error instanceof Error ? error.message : "Unknown",
          },
        );
      }
    }

    // Priority 2: If no GitHub repo, use template from database
    if (!templateUrl && templateType !== "blank") {
      const template = await dbRead.query.appTemplates.findFirst({
        where: eq(appTemplates.slug, templateType),
      });
      templateUrl = template?.github_repo
        ? `https://github.com/${template.github_repo}`
        : undefined;

      if (!templateUrl) {
        logger.info(
          "Template not found in database, using prompt-based template guidance",
          { templateType },
        );
      } else {
        logger.info("Using template from database", {
          templateType,
          templateUrl,
        });
      }
    }

    // Determine API URL for sandbox
    // For local dev: use postMessage proxy bridge (no ngrok required!)
    // For production: use direct API URL
    const isLocalDev =
      process.env.NEXT_PUBLIC_APP_URL?.includes("localhost") ||
      process.env.NEXT_PUBLIC_APP_URL?.includes("127.0.0.1");

    const sandboxEnv: Record<string, string> = {};

    if (isLocalDev) {
      // Local development: Use postMessage proxy bridge
      // The sandbox will embed an iframe to /sandbox-proxy which forwards API calls to localhost
      const localServerUrl =
        process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
      sandboxEnv.NEXT_PUBLIC_ELIZA_PROXY_URL = localServerUrl;

      // If ELIZA_API_URL is explicitly set (e.g., ngrok), use it as a direct API URL instead
      if (process.env.ELIZA_API_URL) {
        sandboxEnv.NEXT_PUBLIC_ELIZA_API_URL = process.env.ELIZA_API_URL;
        delete sandboxEnv.NEXT_PUBLIC_ELIZA_PROXY_URL; // Don't use proxy if direct URL is set
      }

      logger.info("Local dev mode: using postMessage proxy bridge", {
        proxyUrl: sandboxEnv.NEXT_PUBLIC_ELIZA_PROXY_URL,
        directUrl: sandboxEnv.NEXT_PUBLIC_ELIZA_API_URL,
      });
    } else {
      // Production: Use direct API URL
      const apiUrl =
        process.env.ELIZA_API_URL || process.env.NEXT_PUBLIC_APP_URL;
      if (apiUrl) {
        sandboxEnv.NEXT_PUBLIC_ELIZA_API_URL = apiUrl;
      }
    }

    if (appApiKey) {
      sandboxEnv.NEXT_PUBLIC_ELIZA_API_KEY = appApiKey;
    }
    if (appId) {
      sandboxEnv.NEXT_PUBLIC_ELIZA_APP_ID = appId;
    }

    // Detect if the app needs a database based on:
    // 1. User explicitly requested persistent storage
    // 2. Prompt analysis (detects stateful keywords/phrases) as fallback
    let includeDatabase = false;
    const promptToAnalyze = initialPrompt || appDescription || "";

    // Analyze prompt for stateful indicators (fallback if user didn't explicitly choose)
    const detectionResult = promptToAnalyze
      ? getDetailedAnalysis(promptToAnalyze)
      : null;

    // Provision database if user explicitly requested OR if prompt analysis detects need
    const shouldProvisionDatabase =
      includePersistentStorage || (detectionResult?.requiresDatabase && appId);

    if (shouldProvisionDatabase && appId) {
      logger.info("Database required, provisioning", {
        appId,
        reason: includePersistentStorage
          ? "user requested persistent storage"
          : `prompt analysis: ${detectionResult?.summary}`,
        confidence: detectionResult?.confidence,
      });

      // Provision database for the app
      const dbResult = await userDatabaseService.provisionDatabase(
        appId,
        appName || "app",
      );

      if (dbResult.success && dbResult.connectionUri) {
        // NOTE: We intentionally do NOT inject DATABASE_URL into the sandbox globally.
        // DATABASE_URL is injected per-command when the AI runs drizzle-kit commands
        // via run_command - credentials are fetched from our backend and never persist.
        includeDatabase = true;

        logger.info("Database provisioned successfully", {
          appId,
          projectId: dbResult.projectId,
          region: dbResult.region,
        });
      } else {
        // Log warning but continue without database (graceful degradation)
        logger.warn(
          "Database provisioning failed, continuing without database",
          {
            appId,
            error: dbResult.error,
            errorCode: dbResult.errorCode,
          },
        );
      }
    } else if (!shouldProvisionDatabase) {
      logger.info("No database provisioning needed", {
        appId,
        templateType,
        includePersistentStorage,
        promptAnalysisConfidence: detectionResult?.confidence,
      });
    }

    const sandboxData = await sandboxService.create({
      templateUrl,
      timeout: 30 * 60 * 1000,
      vcpus: 4,
      organizationId,
      projectId: appId,
      env: Object.keys(sandboxEnv).length > 0 ? sandboxEnv : undefined,
      onProgress,
    });

    const systemPrompt = buildFullAppPrompt({
      templateType: templateType as FullAppTemplateType,
      includeMonetization,
      includeAnalytics,
      includeDatabase,
      customInstructions: appDescription
        ? `Build an app with the following requirements:\n${appDescription}`
        : initialPrompt
          ? `Initial request:\n${initialPrompt}`
          : undefined,
    });

    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

    const [session] = await dbWrite
      .insert(appSandboxSessions)
      .values({
        user_id: userId,
        organization_id: organizationId,
        app_id: appId,
        sandbox_id: sandboxData.sandboxId,
        sandbox_url: sandboxData.sandboxUrl,
        status: "ready",
        app_name: appName,
        app_description: appDescription,
        initial_prompt: initialPrompt,
        template_type: templateType,
        build_config: {
          features: [],
          includeMonetization,
          includeAnalytics,
          includeDatabase,
        },
        claude_messages: [],
        started_at: new Date(),
        expires_at: expiresAt,
      } satisfies NewAppSandboxSession)
      .returning();

    await dbWrite.insert(appBuilderPrompts).values({
      sandbox_session_id: session.id,
      role: "system",
      content: systemPrompt,
      status: "completed",
      completed_at: new Date(),
    } satisfies NewAppBuilderPrompt);

    const examplePrompts =
      EXAMPLE_PROMPTS[templateType] || EXAMPLE_PROMPTS.blank;

    logger.info("AI App Builder session started", {
      sessionId: session.id,
      sandboxId: sandboxData.sandboxId,
      sandboxUrl: sandboxData.sandboxUrl,
    });

    const baseSession: BuilderSession = {
      id: session.id,
      sandboxId: sandboxData.sandboxId,
      sandboxUrl: sandboxData.sandboxUrl,
      status: "ready" as BuilderSession["status"],
      messages: [],
      examplePrompts,
      expiresAt: expiresAt.toISOString(),
      appId,
      githubRepo,
      hasDatabase: includeDatabase,
    };

    if (onSandboxReady) {
      onSandboxReady(baseSession);
    }

    let initialPromptResult: PromptResult | undefined;
    let processedInitialPrompt: string | undefined;

    if (initialPrompt) {
      processedInitialPrompt = initialPrompt;
      logger.info("Executing initial prompt as part of session creation", {
        sessionId: session.id,
        promptLength: initialPrompt.length,
      });

      initialPromptResult = await this.sendPrompt(
        session.id,
        initialPrompt,
        userId,
        { onToolUse, onThinking, abortSignal },
      );

      logger.info("Initial prompt completed", {
        sessionId: session.id,
        success: initialPromptResult.success,
        filesAffected: initialPromptResult.filesAffected.length,
      });
    }

    const finalMessages: BuilderSession["messages"] = [];
    if (initialPromptResult && processedInitialPrompt) {
      finalMessages.push(
        {
          role: "user",
          content: processedInitialPrompt,
          timestamp: new Date().toISOString(),
        },
        {
          role: "assistant",
          content: initialPromptResult.output,
          timestamp: new Date().toISOString(),
        },
      );
    }

    return {
      id: session.id,
      sandboxId: sandboxData.sandboxId,
      sandboxUrl: sandboxData.sandboxUrl,
      status: "ready" as BuilderSession["status"],
      messages: finalMessages,
      examplePrompts,
      expiresAt: expiresAt.toISOString(),
      initialPromptResult,
      appId,
      githubRepo,
      hasDatabase: includeDatabase,
    };
  }

  async sendPrompt(
    sessionId: string,
    prompt: string,
    userId: string,
    options: {
      onToolUse?: (tool: string, input: unknown, result: string) => void;
      onThinking?: (text: string) => void;
      abortSignal?: AbortSignal;
    } = {},
  ): Promise<PromptResult> {
    logger.info("Sending prompt to AI App Builder", {
      sessionId,
      promptLength: prompt.length,
    });

    const session = await this.verifyOwnership(sessionId, userId);

    if (!session.sandbox_id) throw new Error("Sandbox not available");
    if (session.status !== "ready")
      throw new Error(
        `Session is not ready. Current status: ${session.status}`,
      );

    await dbWrite
      .update(appSandboxSessions)
      .set({ status: "generating", updated_at: new Date() })
      .where(eq(appSandboxSessions.id, sessionId));

    const [promptRecord] = await dbWrite
      .insert(appBuilderPrompts)
      .values({
        sandbox_session_id: sessionId,
        role: "user",
        content: prompt,
        status: "processing",
      } satisfies NewAppBuilderPrompt)
      .returning();

    const systemPromptRecord = await dbRead.query.appBuilderPrompts.findFirst({
      where: and(
        eq(appBuilderPrompts.sandbox_session_id, sessionId),
        eq(appBuilderPrompts.role, "system"),
      ),
    });

    // Get sandbox instance for AI execution
    const sandbox = sandboxService.getSandboxInstance(session.sandbox_id);
    if (!sandbox) {
      throw new Error(`Sandbox instance not found for ${session.sandbox_id}`);
    }

    const startTime = Date.now();
    const result = await appBuilderAISDK.execute(
      prompt,
      {
        sandbox,
        sandboxId: session.sandbox_id,
        appId: session.app_id || undefined,
        systemPrompt: systemPromptRecord?.content,
        abortSignal: options.abortSignal,
      },
      {
        onToolResult: options.onToolUse,
        onThinking: options.onThinking,
      },
    );
    const durationMs = Date.now() - startTime;

    await dbWrite
      .update(appBuilderPrompts)
      .set({
        status: result.success ? "completed" : "error",
        files_affected: result.filesAffected,
        error_message: result.success ? null : result.output,
        completed_at: new Date(),
        duration_ms: durationMs,
      })
      .where(eq(appBuilderPrompts.id, promptRecord.id));

    await dbWrite.insert(appBuilderPrompts).values({
      sandbox_session_id: sessionId,
      role: "assistant",
      content: result.output,
      files_affected: result.filesAffected,
      status: "completed",
      completed_at: new Date(),
    } satisfies NewAppBuilderPrompt);

    const messages =
      (session.claude_messages as BuilderSession["messages"]) || [];
    messages.push(
      { role: "user", content: prompt, timestamp: new Date().toISOString() },
      {
        role: "assistant",
        content: result.output,
        timestamp: new Date().toISOString(),
      },
    );

    await dbWrite
      .update(appSandboxSessions)
      .set({
        status: "ready",
        claude_messages: messages,
        updated_at: new Date(),
      })
      .where(eq(appSandboxSessions.id, sessionId));

    logger.info("Prompt completed", {
      sessionId,
      success: result.success,
      filesAffected: result.filesAffected.length,
      durationMs,
    });

    // Auto-commit to GitHub if files were changed and app has a repo
    if (result.success && result.filesAffected.length > 0 && session.app_id) {
      this.autoCommitToGitHub(session, prompt, result.filesAffected).catch(
        (err) =>
          logger.warn("Auto-commit failed (non-blocking)", {
            sessionId,
            error: err instanceof Error ? err.message : "Unknown error",
          }),
      );
    }

    return result;
  }

  /**
   * Auto-commit changes to GitHub after a successful prompt.
   * This runs in the background and doesn't block the response.
   */
  private async autoCommitToGitHub(
    session: AppSandboxSession,
    prompt: string,
    filesAffected: string[],
  ): Promise<void> {
    if (!session.sandbox_id || !session.app_id) return;

    const app = await appsService.getById(session.app_id);
    if (!app?.github_repo) {
      logger.debug("Skipping auto-commit: no GitHub repo configured", {
        sessionId: session.id,
        appId: session.app_id,
      });
      return;
    }

    // Generate a meaningful commit message from the prompt
    const shortPrompt = prompt.slice(0, 100).replace(/\n/g, " ");
    const commitMessage = `AI: ${shortPrompt}${prompt.length > 100 ? "..." : ""}\n\nFiles: ${filesAffected.join(", ")}`;

    logger.info("Auto-committing to GitHub", {
      sessionId: session.id,
      appId: session.app_id,
      githubRepo: app.github_repo,
      filesCount: filesAffected.length,
    });

    const commitResult = await gitSyncService.commitAndPush(
      {
        sandboxId: session.sandbox_id,
        repoFullName: app.github_repo,
        branch: session.git_branch || "main",
      },
      {
        message: commitMessage,
        // Use environment variables for commit author to match your GitHub account for Vercel attribution
        author: {
          name: process.env.GIT_COMMIT_AUTHOR_NAME || "ElizaCloud AI Builder",
          email: process.env.GIT_COMMIT_AUTHOR_EMAIL || "ai@elizacloud.ai",
        },
      },
    );

    if (commitResult.success && commitResult.commitSha) {
      // Update session with last commit info
      await dbWrite
        .update(appSandboxSessions)
        .set({
          last_commit_sha: commitResult.commitSha,
          updated_at: new Date(),
        })
        .where(eq(appSandboxSessions.id, session.id));

      // Also update the prompt record with the commit SHA
      await dbWrite
        .update(appBuilderPrompts)
        .set({ commit_sha: commitResult.commitSha })
        .where(
          and(
            eq(appBuilderPrompts.sandbox_session_id, session.id),
            eq(appBuilderPrompts.role, "user"),
          ),
        );

      logger.info("Auto-commit successful", {
        sessionId: session.id,
        commitSha: commitResult.commitSha,
        filesCommitted: commitResult.filesCommitted,
      });
    } else {
      logger.warn("Auto-commit failed", {
        sessionId: session.id,
        error: commitResult.error,
      });
    }
  }

  async verifySessionOwnership(
    sessionId: string,
    userId: string,
  ): Promise<AppSandboxSession> {
    return this.verifyOwnership(sessionId, userId);
  }

  async getSession(
    sessionId: string,
    userId: string,
  ): Promise<BuilderSession | null> {
    const session = await this.verifyOwnership(sessionId, userId);

    let currentStatus = session.status;

    if (session.expires_at && new Date(session.expires_at) < new Date()) {
      currentStatus = "timeout";
      await dbWrite
        .update(appSandboxSessions)
        .set({ status: "timeout", updated_at: new Date() })
        .where(eq(appSandboxSessions.id, sessionId));
      logger.info("Session marked as timeout due to expiration", { sessionId });
    } else if (
      session.sandbox_id &&
      currentStatus !== "stopped" &&
      currentStatus !== "timeout"
    ) {
      const sandboxStatus = sandboxService.getStatus(session.sandbox_id);
      if (sandboxStatus === "unknown") {
        currentStatus = "timeout";
        await dbWrite
          .update(appSandboxSessions)
          .set({ status: "timeout", updated_at: new Date() })
          .where(eq(appSandboxSessions.id, sessionId));
        logger.info("Session marked as timeout due to missing sandbox", {
          sessionId,
          sandboxId: session.sandbox_id,
        });
      }
    }

    const prompts = await dbRead.query.appBuilderPrompts.findMany({
      where: eq(appBuilderPrompts.sandbox_session_id, sessionId),
      orderBy: [desc(appBuilderPrompts.created_at)],
    });

    const messages = prompts
      .filter((p) => p.role !== "system")
      .map((p) => ({
        role: p.role as "user" | "assistant",
        content: p.content,
        timestamp: p.created_at.toISOString(),
      }))
      .reverse();

    const templateType =
      (session.template_type as keyof typeof EXAMPLE_PROMPTS) || "blank";
    const examplePrompts =
      EXAMPLE_PROMPTS[templateType] || EXAMPLE_PROMPTS.blank;

    return {
      id: session.id,
      sandboxId: session.sandbox_id || "",
      sandboxUrl: session.sandbox_url || "",
      status: currentStatus as BuilderSession["status"],
      messages,
      examplePrompts,
      expiresAt: session.expires_at?.toISOString() || null,
      appId: session.app_id || undefined,
    };
  }

  async listSessions(
    userId: string,
    options: { limit?: number; includeInactive?: boolean; appId?: string } = {},
  ): Promise<AppSandboxSession[]> {
    const { limit = 10, includeInactive = false, appId } = options;

    const conditions = [eq(appSandboxSessions.user_id, userId)];
    if (appId) {
      conditions.push(eq(appSandboxSessions.app_id, appId));
    }

    const sessions = await dbRead.query.appSandboxSessions.findMany({
      where: conditions.length > 1 ? and(...conditions) : conditions[0],
      orderBy: [desc(appSandboxSessions.created_at)],
      limit,
    });

    if (!includeInactive) {
      return sessions.filter(
        (s) => s.status !== "stopped" && s.status !== "timeout",
      );
    }

    return sessions;
  }

  async extendSession(
    sessionId: string,
    userId: string,
    durationMs: number = 15 * 60 * 1000,
  ): Promise<{ expiresAt: Date }> {
    const session = await this.verifyOwnership(sessionId, userId);

    if (!session.sandbox_id) throw new Error("Sandbox not available");

    await sandboxService.extendTimeout(session.sandbox_id, durationMs);

    const currentExpiresAt = session.expires_at
      ? new Date(session.expires_at)
      : new Date();
    const baseTime =
      currentExpiresAt.getTime() > Date.now()
        ? currentExpiresAt.getTime()
        : Date.now();
    const newExpiresAt = new Date(baseTime + durationMs);

    await dbWrite
      .update(appSandboxSessions)
      .set({ expires_at: newExpiresAt, updated_at: new Date() })
      .where(eq(appSandboxSessions.id, sessionId));

    logger.info("Extended session timeout", {
      sessionId,
      previousExpiresAt: currentExpiresAt,
      newExpiresAt,
      addedMs: durationMs,
    });

    return { expiresAt: newExpiresAt };
  }

  async getLogs(
    sessionId: string,
    userId: string,
    tail = 50,
  ): Promise<string[]> {
    const session = await this.verifyOwnership(sessionId, userId);
    if (!session.sandbox_id) return [];
    return sandboxService.getLogs(session.sandbox_id, tail);
  }

  async stopSession(sessionId: string, userId: string): Promise<void> {
    const session = await this.verifyOwnership(sessionId, userId);

    if (session.sandbox_id) {
      await sandboxService.stop(session.sandbox_id);
    }

    await dbWrite
      .update(appSandboxSessions)
      .set({
        status: "stopped",
        stopped_at: new Date(),
        updated_at: new Date(),
      })
      .where(eq(appSandboxSessions.id, sessionId));

    logger.info("Session stopped", { sessionId });
  }

  /**
   * Reset session status back to "ready" after an error.
   * This allows the user to try sending another prompt.
   */
  async resetSessionStatus(sessionId: string, userId: string): Promise<void> {
    await this.verifyOwnership(sessionId, userId);

    await dbWrite
      .update(appSandboxSessions)
      .set({
        status: "ready",
        updated_at: new Date(),
      })
      .where(eq(appSandboxSessions.id, sessionId));

    logger.info("Session status reset to ready", { sessionId });
  }
  /**
   * Resume a timed-out or stopped session by creating a new sandbox.
   * If the app has a GitHub repo, the sandbox will be cloned from it.
   * Messages from the old session are preserved.
   */
  async resumeSession(
    sessionId: string,
    userId: string,
    options: {
      onProgress?: (progress: SandboxProgress) => void;
      onRestoreProgress?: (progress: {
        current: number;
        total: number;
        filePath: string;
      }) => void;
    } = {},
  ): Promise<BuilderSession> {
    const { onProgress, onRestoreProgress } = options;

    const session = await this.verifyOwnership(sessionId, userId);

    // If session is already ready, just return it (no action needed)
    // This prevents infinite loops when client tries to resume an already-ready session
    if (session.status === "ready") {
      logger.info("Session is already ready, returning current state", {
        sessionId,
        sandboxId: session.sandbox_id,
      });

      // Get messages from the session
      const prompts = await dbRead.query.appBuilderPrompts.findMany({
        where: eq(appBuilderPrompts.sandbox_session_id, sessionId),
        orderBy: [desc(appBuilderPrompts.created_at)],
      });

      const messages = prompts
        .filter((p) => p.role !== "system")
        .map((p) => ({
          role: p.role as "user" | "assistant",
          content: p.content,
          timestamp: p.created_at.toISOString(),
        }))
        .reverse();

      const templateType =
        (session.template_type as keyof typeof EXAMPLE_PROMPTS) || "blank";
      const examplePrompts =
        EXAMPLE_PROMPTS[templateType] || EXAMPLE_PROMPTS.blank;

      // Get the app's github repo if available
      let githubRepo: string | null = null;
      if (session.app_id) {
        const app = await appsService.getById(session.app_id);
        githubRepo = app?.github_repo || null;
      }

      if (!session.sandbox_id || !session.sandbox_url) {
        throw new Error("Ready session is missing sandbox metadata");
      }
      return {
        id: session.id,
        sandboxId: session.sandbox_id,
        sandboxUrl: session.sandbox_url,
        status: session.status,
        messages,
        examplePrompts,
        expiresAt: session.expires_at ? session.expires_at.toISOString() : null,
        appId: session.app_id || undefined,
        githubRepo,
      };
    }

    // Check if session can be resumed (must be timeout or stopped)
    if (session.status !== "timeout" && session.status !== "stopped") {
      throw new Error(
        `Session cannot be resumed. Current status: ${session.status}`,
      );
    }

    logger.info("Resuming session", {
      sessionId,
      oldSandboxId: session.sandbox_id,
      oldSandboxUrl: session.sandbox_url,
      appId: session.app_id,
    });

    // Get the app to check for GitHub repo (needed for both reconnection and new sandbox)
    let githubRepo: string | null = null;
    if (session.app_id) {
      const app = await appsService.getById(session.app_id);
      githubRepo = app?.github_repo || null;
    }

    let sandboxData: {
      sandboxId: string;
      sandboxUrl: string;
      status: string;
      devServerUrl?: string;
      startedAt?: Date;
    };

    // FAST PATH: Try to reconnect to the existing sandbox first
    // This can save 30-60 seconds compared to creating a new sandbox
    if (session.sandbox_id && session.sandbox_url) {
      logger.info("Attempting fast reconnection to existing sandbox", {
        sessionId,
        sandboxId: session.sandbox_id,
      });

      const reconnected = await sandboxService.tryReconnect(
        session.sandbox_id,
        session.sandbox_url,
        { onProgress, timeoutMs: 30 * 60 * 1000 },
      );

      if (reconnected) {
        logger.info(
          "Successfully reconnected to existing sandbox (fast path)",
          {
            sessionId,
            sandboxId: reconnected.sandboxId,
          },
        );
        sandboxData = reconnected;

        // Report instant restore
        if (onRestoreProgress) {
          onRestoreProgress({
            current: 1,
            total: 1,
            filePath: "Reconnected to existing sandbox",
          });
        }
      } else {
        logger.info(
          "Reconnection failed, falling back to new sandbox creation",
          {
            sessionId,
          },
        );
        sandboxData = await this.createNewSandboxForResume(
          session,
          githubRepo,
          options,
        );
      }
    } else {
      // No existing sandbox info - create new
      sandboxData = await this.createNewSandboxForResume(
        session,
        githubRepo,
        options,
      );
    }

    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

    // Update session with new sandbox info
    await dbWrite
      .update(appSandboxSessions)
      .set({
        sandbox_id: sandboxData.sandboxId,
        sandbox_url: sandboxData.sandboxUrl,
        status: "ready",
        expires_at: expiresAt,
        updated_at: new Date(),
      })
      .where(eq(appSandboxSessions.id, sessionId));

    // Configure git if we have a GitHub repo
    if (githubRepo && sandboxData.sandboxId) {
      try {
        await gitSyncService.configureGit({
          sandboxId: sandboxData.sandboxId,
          repoFullName: githubRepo,
          branch: session.git_branch || "main",
        });
        logger.info("Git configured for resumed session", {
          sessionId,
          githubRepo,
        });
      } catch (error) {
        logger.warn("Failed to configure git for resumed session", {
          sessionId,
          error: error instanceof Error ? error.message : "Unknown",
        });
      }
    }

    // Get messages from the old session
    const prompts = await dbRead.query.appBuilderPrompts.findMany({
      where: eq(appBuilderPrompts.sandbox_session_id, sessionId),
      orderBy: [desc(appBuilderPrompts.created_at)],
    });

    const messages = prompts
      .filter((p) => p.role !== "system")
      .map((p) => ({
        role: p.role as "user" | "assistant",
        content: p.content,
        timestamp: p.created_at.toISOString(),
      }))
      .reverse();

    const templateType =
      (session.template_type as keyof typeof EXAMPLE_PROMPTS) || "blank";
    const examplePrompts =
      EXAMPLE_PROMPTS[templateType] || EXAMPLE_PROMPTS.blank;

    logger.info("Session resumed successfully", {
      sessionId,
      newSandboxId: sandboxData.sandboxId,
      sandboxUrl: sandboxData.sandboxUrl,
      messagesRestored: messages.length,
    });

    return {
      id: session.id,
      sandboxId: sandboxData.sandboxId,
      sandboxUrl: sandboxData.sandboxUrl,
      status: "ready" as BuilderSession["status"],
      messages,
      examplePrompts,
      expiresAt: expiresAt.toISOString(),
      appId: session.app_id || undefined,
      githubRepo,
    };
  }

  /**
   * Helper method to create a new sandbox for session resume.
   * Used when reconnection to existing sandbox fails.
   */
  private async createNewSandboxForResume(
    session: AppSandboxSession,
    githubRepo: string | null,
    options: {
      onProgress?: (progress: SandboxProgress) => void;
      onRestoreProgress?: (progress: {
        current: number;
        total: number;
        filePath: string;
      }) => void;
    },
  ): Promise<{
    sandboxId: string;
    sandboxUrl: string;
    status: string;
    devServerUrl?: string;
    startedAt?: Date;
  }> {
    const { onProgress, onRestoreProgress } = options;

    // Determine template URL for sandbox creation
    let templateUrl: string | undefined;

    if (githubRepo) {
      const repoName = githubRepo.split("/").pop() || githubRepo;
      try {
        templateUrl = githubReposService.getAuthenticatedCloneUrl(repoName);
        logger.info("Creating sandbox from GitHub repo", {
          sessionId: session.id,
          githubRepo,
          repoName,
        });
      } catch (error) {
        logger.warn("Failed to get authenticated clone URL for resume", {
          sessionId: session.id,
          githubRepo,
          error: error instanceof Error ? error.message : "Unknown",
        });
      }
    }

    // Notify progress
    onProgress?.({
      step: "creating",
      message: "Creating new sandbox instance...",
    });

    // Determine API URL for sandbox
    const isLocalDev =
      process.env.NEXT_PUBLIC_APP_URL?.includes("localhost") ||
      process.env.NEXT_PUBLIC_APP_URL?.includes("127.0.0.1");

    const sandboxEnv: Record<string, string> = {};

    if (isLocalDev) {
      const localServerUrl =
        process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
      sandboxEnv.NEXT_PUBLIC_ELIZA_PROXY_URL = localServerUrl;

      if (process.env.ELIZA_API_URL) {
        sandboxEnv.NEXT_PUBLIC_ELIZA_API_URL = process.env.ELIZA_API_URL;
        delete sandboxEnv.NEXT_PUBLIC_ELIZA_PROXY_URL;
      }
    } else {
      const apiUrl =
        process.env.ELIZA_API_URL || process.env.NEXT_PUBLIC_APP_URL;
      if (apiUrl) {
        sandboxEnv.NEXT_PUBLIC_ELIZA_API_URL = apiUrl;
      }
    }

    // Get or regenerate API key for the app
    if (session.app_id) {
      const appApiKey = await appsService.regenerateApiKey(session.app_id);
      if (appApiKey) {
        sandboxEnv.NEXT_PUBLIC_ELIZA_API_KEY = appApiKey;
      }
      sandboxEnv.NEXT_PUBLIC_ELIZA_APP_ID = session.app_id;
    }

    // Create new sandbox
    const sandboxData = await sandboxService.create({
      templateUrl,
      timeout: 30 * 60 * 1000,
      vcpus: 4,
      organizationId: session.organization_id,
      projectId: session.app_id || undefined,
      env: Object.keys(sandboxEnv).length > 0 ? sandboxEnv : undefined,
      onProgress,
    });

    // Report restore progress if we're using a GitHub template
    if (templateUrl && onRestoreProgress) {
      onRestoreProgress({
        current: 1,
        total: 1,
        filePath: "Cloned from GitHub",
      });
    }

    return sandboxData;
  }
}

export const aiAppBuilderService = new AIAppBuilderService();
// Alias for backwards compatibility with existing imports
export const aiAppBuilder = aiAppBuilderService;
