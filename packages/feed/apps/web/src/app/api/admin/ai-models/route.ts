/**
 * Admin AI Models API
 *
 * @route GET /api/admin/ai-models - Get AI model configuration
 * @access Admin
 *
 * @description
 * Returns current AI provider configuration and available providers.
 *
 * @openapi
 * /api/admin/ai-models:
 *   get:
 *     tags:
 *       - Admin
 *     summary: Get AI model configuration
 *     description: Returns current AI configuration and available providers (admin only)
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Configuration retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 activeProvider:
 *                   type: string
 *                 providers:
 *                   type: object
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 *
 * @example
 * ```typescript
 * const config = await fetch('/api/admin/ai-models', {
 *   headers: { 'Authorization': `Bearer ${adminToken}` }
 * }).then(r => r.json());
 * ```
 */

import {
  getClientIp,
  logAdminView,
  requireAdmin,
  withErrorHandling,
} from "@feed/api";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

/**
 * GET /api/admin/ai-models
 * Returns current AI configuration and available providers
 */
export const GET = withErrorHandling(async (req: NextRequest) => {
  const admin = await requireAdmin(req);

  // Audit log the view
  logAdminView({
    adminId: admin.userId,
    ipAddress: getClientIp(req.headers) ?? undefined,
    resourceType: "ai_models",
    metadata: { action: "view_config" },
  });

  // Check available providers
  const providers = {
    groq: !!process.env.GROQ_API_KEY,
    claude: !!process.env.ANTHROPIC_API_KEY,
    openai: !!process.env.OPENAI_API_KEY,
  };

  // Get active provider (based on priority: Groq > Claude > OpenAI)
  let activeProvider: "groq" | "claude" | "openai" = "openai";
  if (providers.groq) {
    activeProvider = "groq";
  } else if (providers.claude) {
    activeProvider = "claude";
  }

  return NextResponse.json({
    success: true,
    data: {
      providers,
      activeProvider,
      recommendedModels: [
        {
          id: "openai/gpt-oss-120b",
          name: "GPT OSS 120B (Groq)",
          description:
            "⭐ Best for quality content: events, articles, posts, decisions",
        },
        {
          id: "llama-3.1-8b-instant",
          name: "Llama 3.1 8B Instant (Groq)",
          description:
            "🚀 Best for frequent operations: comments, DMs, tags, evaluations",
        },
      ],
    },
  });
});
