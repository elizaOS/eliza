import { NextRequest } from "next/server";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import {
  aiAppBuilderService as aiAppBuilder,
  type SandboxProgress,
} from "@/lib/services/ai-app-builder";
import { logger } from "@/lib/utils/logger";
import { z } from "zod";
import { checkRateLimitAsync } from "@/lib/middleware/rate-limit";
import { createStreamWriter, SSE_HEADERS } from "@/lib/api/stream-utils";

// Max duration for sandbox creation and initial prompt processing
// Fluid compute limits: Hobby 300s, Pro/Enterprise 800s
export const maxDuration = 800;

const SESSION_CREATE_LIMIT = {
  windowMs: 3600000,
  maxRequests: process.env.NODE_ENV === "production" ? 5 : 100,
};

const CreateSessionSchema = z.object({
  appId: z.string().uuid().optional(),
  appName: z.string().min(1).max(100).optional(),
  appDescription: z.string().max(500).optional(),
  initialPrompt: z.string().max(2000).optional(),
  templateType: z
    .enum([
      "chat",
      "agent-dashboard",
      "landing-page",
      "analytics",
      "blank",
      "mcp-service",
      "a2a-agent",
      "saas-starter",
      "ai-tool",
    ])
    .default("blank"),
  includeMonetization: z.boolean().default(true),
  includeAnalytics: z.boolean().default(true),
  includePersistentStorage: z.boolean().default(false),
  linkedAgentIds: z.array(z.string().uuid()).max(4).optional(),
});

export async function POST(request: NextRequest) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);

    const rateLimitResult = await checkRateLimitAsync(
      request,
      SESSION_CREATE_LIMIT,
    );
    if (!rateLimitResult.allowed) {
      const maxRequests = SESSION_CREATE_LIMIT.maxRequests;
      const windowSeconds = SESSION_CREATE_LIMIT.windowMs / 1000;
      return new Response(
        JSON.stringify({
          success: false,
          error: `Rate limit exceeded. Maximum ${maxRequests} sandbox sessions per ${windowSeconds}s.`,
          retryAfter: rateLimitResult.retryAfter,
        }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": rateLimitResult.retryAfter?.toString() || "3600",
          },
        },
      );
    }

    const body = await request.json();
    const validationResult = CreateSessionSchema.safeParse(body);

    if (!validationResult.success) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Invalid request data",
          details: validationResult.error.format(),
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const data = validationResult.data;

    const stream = new TransformStream();
    const rawWriter = stream.writable.getWriter();
    const streamWriter = createStreamWriter(rawWriter);

    const abortController = new AbortController();

    request.signal?.addEventListener("abort", () => {
      logger.info("Client aborted session creation request");
      abortController.abort();
    });

    (async () => {
      streamWriter.startHeartbeat(15000);

      try {
        const session = await aiAppBuilder.startSession({
          userId: user.id,
          organizationId: user.organization_id,
          appId: data.appId,
          appName: data.appName,
          appDescription: data.appDescription,
          initialPrompt: data.initialPrompt,
          templateType: data.templateType,
          includeMonetization: data.includeMonetization,
          includeAnalytics: data.includeAnalytics,
          includePersistentStorage: data.includePersistentStorage,
          linkedAgentIds: data.linkedAgentIds,
          onProgress: async (progress: SandboxProgress) => {
            if (!streamWriter.isConnected()) return;
            await streamWriter.sendEvent("progress", progress);
          },
          onSandboxReady: async (readySession) => {
            if (!streamWriter.isConnected()) return;
            await streamWriter.sendEvent("sandbox_ready", {
              session: {
                id: readySession.id,
                sandboxId: readySession.sandboxId,
                sandboxUrl: readySession.sandboxUrl,
                status: readySession.status,
                examplePrompts: readySession.examplePrompts,
                expiresAt: readySession.expiresAt,
                appId: readySession.appId,
                githubRepo: readySession.githubRepo,
                hasDatabase: readySession.hasDatabase,
              },
              hasInitialPrompt: !!data.initialPrompt,
            });
          },
          onToolUse: async (tool, input, result) => {
            if (!streamWriter.isConnected()) return;
            await streamWriter.sendEvent("tool_use", {
              tool,
              input,
              result, // Full result - no truncation!
            });
          },
          onThinking: async (text) => {
            if (!streamWriter.isConnected()) return;
            await streamWriter.sendEvent("thinking", {
              text, // Full text - no truncation!
            });
          },
          abortSignal: abortController.signal,
        });

        logger.info("Created app builder session via stream", {
          sessionId: session.id,
          userId: user.id,
        });

        if (streamWriter.isConnected()) {
          await streamWriter.sendEvent("complete", {
            success: true,
            session: {
              id: session.id,
              sandboxId: session.sandboxId,
              sandboxUrl: session.sandboxUrl,
              status: session.status,
              examplePrompts: session.examplePrompts,
              messages: session.messages,
              initialPromptResult: session.initialPromptResult,
              appId: session.appId,
              githubRepo: session.githubRepo,
              hasDatabase: session.hasDatabase,
            },
          });
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Failed to create session";

        if (
          errorMessage.includes("aborted") ||
          errorMessage.includes("cancelled")
        ) {
          logger.info("Session creation cancelled by client");
          if (streamWriter.isConnected()) {
            await streamWriter.sendEvent("cancelled", {
              success: false,
              error: "Session creation cancelled",
            });
          }
        } else {
          logger.error("Failed to create app builder session via stream", {
            error: errorMessage,
          });
          if (streamWriter.isConnected()) {
            await streamWriter.sendEvent("error", {
              success: false,
              error: errorMessage,
            });
          }
        }
      } finally {
        await streamWriter.close();
      }
    })();

    return new Response(stream.readable, { headers: SSE_HEADERS });
  } catch (error) {
    logger.error("Error in app builder stream", { error });
    const message = error instanceof Error ? error.message : "Internal error";

    let status = 500;
    if (
      message.includes("Authentication") ||
      message.includes("Unauthorized")
    ) {
      status = 401;
    } else if (
      message.includes("Access denied") ||
      message.includes("Forbidden")
    ) {
      status = 403;
    } else if (message.includes("not found")) {
      status = 404;
    } else if (message.includes("Rate limit")) {
      status = 429;
    } else if (message.includes("Invalid") || message.includes("JSON")) {
      status = 400;
    }

    return new Response(JSON.stringify({ success: false, error: message }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }
}
