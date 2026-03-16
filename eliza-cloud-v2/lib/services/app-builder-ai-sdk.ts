/**
 * AI SDK App Builder Service
 *
 * Single source of truth for AI-powered code generation in the App Builder.
 * Uses Vercel's AI SDK with streaming and full tool execution support.
 *
 * Key features:
 * - Uses AI Gateway for model flexibility (no hardcoded models)
 * - Real-time streaming responses with FULL reasoning/thinking token exposure
 * - Full tool execution with manual loop (SDK v6.0.x pattern)
 * - Abort signal support for cancellation
 * - Build checks only at the end (not per-file)
 *
 * IMPORTANT: Uses fullStream to capture ALL parts including:
 * - text-delta: Regular text output
 * - reasoning: Chain-of-thought/thinking tokens (exposed to UI!)
 * - tool-call: Tool invocations
 * - tool-result: Tool execution results
 */

import { streamText, tool } from "ai";
import type { ModelMessage, UserModelMessage, AssistantModelMessage } from "ai";
import { gateway } from "@ai-sdk/gateway";
import { logger } from "@/lib/utils/logger";
import {
  buildFullAppPrompt,
  type FullAppTemplateType,
} from "@/lib/fragments/prompt";

// Import shared utilities from the sandbox module - single source of truth
import {
  type SandboxInstance,
  toolSchemas,
  executeToolCall as sharedExecuteToolCall,
  checkBuild,
  readFileViaSh,
} from "./sandbox/index";

/** Image data for multimodal LLM requests */
export interface ImageData {
  base64: string;
  mimeType: string;
}

// ============================================================================
// Types
// ============================================================================

export type { SandboxInstance } from "./sandbox";

export interface AppBuilderStreamCallbacks {
  onToolCall?: (toolName: string, args: unknown) => void | Promise<void>;
  onToolResult?: (
    toolName: string,
    args: unknown,
    result: string,
  ) => void | Promise<void>;
  onThinking?: (text: string) => void | Promise<void>;
  onReasoning?: (text: string) => void | Promise<void>; // Chain-of-thought tokens
}

export interface AppBuilderConfig {
  sandbox?: SandboxInstance;
  sandboxId?: string;
  /** App ID for tools that need to interact with app-specific resources (e.g., database) */
  appId?: string;
  systemPrompt?: string;
  templateType?: FullAppTemplateType;
  includeMonetization?: boolean;
  includeAnalytics?: boolean;
  /** Include database setup instructions (for stateful apps) */
  includeDatabase?: boolean;
  /** Images attached for multimodal vision analysis */
  images?: ImageData[];
  model?: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}

export interface AppBuilderResult {
  output: string;
  reasoning?: string; // Separate reasoning/thinking for collapsible display
  filesAffected: string[];
  success: boolean;
  error?: string;
  toolCallCount: number;
}

// Event types emitted by the stream
export type AppBuilderEvent =
  | { type: "thinking"; text: string } // Regular text output (shown in UI)
  | { type: "reasoning"; text: string } // Chain-of-thought/reasoning tokens (deep thinking)
  | {
      type: "tool_call";
      toolName: string;
      args: unknown;
      reasoningContext?: string;
    } // Include reasoning that led to this tool call
  | { type: "tool_result"; toolName: string; args: unknown; result: string }
  | { type: "complete"; result: AppBuilderResult }
  | { type: "error"; error: string };

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_TIMEOUT_MS = 13 * 60 * 1000; // 13 minutes - matches Vercel fluid compute max (800s)
const MAX_ITERATIONS = 30;

// Default model - uses AI Gateway so any supported model works
const DEFAULT_MODEL = "anthropic/claude-opus-4.5";

// ============================================================================
// Available Models (fetched dynamically, these are suggestions)
// ============================================================================

const AVAILABLE_MODELS = [
  {
    id: "anthropic/claude-opus-4.5",
    name: "Claude Opus 4.5",
    description: "Most capable model for complex coding tasks",
    isDefault: true,
  },
  {
    id: "anthropic/claude-sonnet-4.5",
    name: "Claude Sonnet 4.5",
    description: "Best balance of speed and capability for coding tasks",
  },
  {
    id: "openai/gpt-5.2-codex",
    name: "GPT-5.2 Codex",
    description: "OpenAI's most capable coding model",
  },
  {
    id: "openai/gpt-5.2",
    name: "GPT-5.2",
    description: "OpenAI's most capable model",
  },
  {
    id: "xai/grok-code-fast-1",
    name: "Grok Code Fast",
    description: "xAI's fast coding model",
  },
  {
    id: "deepseek/deepseek-v3.2",
    name: "DeepSeek V3.2",
    description: "DeepSeek's advanced reasoning model",
  },
  {
    id: "google/gemini-3-flash",
    name: "Gemini 3 Flash",
    description: "Google's fast multimodal model",
  },
];

// ============================================================================
// Main Service Class
// ============================================================================

export class AppBuilderAISDK {
  /**
   * Execute AI-powered code generation with streaming and full tool execution.
   *
   * Uses manual multi-turn loop pattern (SDK v6.0.x compatible):
   * 1. Define tools with inputSchema (no execute)
   * 2. Stream text and get tool calls
   * 3. Execute tools manually and add results to conversation
   * 4. Continue until done
   */
  async *executeStream(
    prompt: string,
    config: AppBuilderConfig,
    callbacks?: AppBuilderStreamCallbacks,
  ): AsyncGenerator<AppBuilderEvent> {
    const {
      sandbox,
      sandboxId,
      appId,
      systemPrompt,
      templateType = "blank",
      includeMonetization = false,
      includeAnalytics = true,
      includeDatabase = false,
      images = [],
      model = DEFAULT_MODEL,
      timeoutMs = DEFAULT_TIMEOUT_MS,
      abortSignal,
    } = config;

    if (!sandbox) {
      yield { type: "error", error: "No sandbox available" };
      yield {
        type: "complete",
        result: {
          output: "Error: No sandbox available",
          filesAffected: [],
          success: false,
          error: "No sandbox available",
          toolCallCount: 0,
        },
      };
      return;
    }

    if (abortSignal?.aborted) {
      yield { type: "error", error: "Operation aborted" };
      yield {
        type: "complete",
        result: {
          output: "Operation aborted",
          filesAffected: [],
          success: false,
          error: "Operation aborted",
          toolCallCount: 0,
        },
      };
      return;
    }

    const filesAffected: string[] = [];
    let outputText = "";
    let allReasoningText = ""; // Accumulate ALL reasoning across iterations
    let toolCallCount = 0;
    const startTime = Date.now();

    const checkTimeout = () => {
      if (Date.now() - startTime > timeoutMs) {
        throw new Error(`Operation timed out after ${timeoutMs / 1000}s`);
      }
    };

    const checkAbort = () => {
      if (abortSignal?.aborted) {
        throw new Error("Operation aborted by client");
      }
    };

    // Track if we completed normally (vs timeout/abort)
    let completedNormally = false;

    try {
      // Build context by reading current files IN PARALLEL for faster startup
      const [pageContent, globalsCss] = await Promise.all([
        readFileViaSh(sandbox, "src/app/page.tsx"),
        readFileViaSh(sandbox, "src/app/globals.css"),
      ]);

      const tailwindWarning =
        globalsCss &&
        (globalsCss.includes("@tailwind") ||
          globalsCss.includes("tailwindcss/tailwind.css"))
          ? `\n⚠️ CRITICAL: globals.css uses Tailwind v3 syntax. Replace with: @import "tailwindcss";\n`
          : "";

      const contextPrompt = `CURRENT FILES:

=== src/app/page.tsx ===
${pageContent || "(not found)"}

=== src/app/globals.css ===
${globalsCss || "(not found)"}
${tailwindWarning}
---
USER REQUEST: ${prompt}

Build this app with your own creative vision.

CRITICAL RULES:
1. install_packages for any npm dependencies FIRST
2. Write leaf components (no local imports) FIRST
3. Write files that import those components SECOND
4. **ALWAYS UPDATE page.tsx** - this is what the user sees! Components alone do NOTHING.
5. NEVER import @/components/* or @/lib/* paths that don't exist yet - this breaks the build!
6. Call check_build once at the end.

⚠️ YOUR TASK IS NOT COMPLETE UNTIL page.tsx RENDERS THE UI! Writing components without updating page.tsx is a failure - the user sees a blank page.`;

      const finalSystemPrompt =
        systemPrompt ||
        buildFullAppPrompt({
          templateType,
          includeMonetization,
          includeAnalytics,
          includeDatabase,
        });

      logger.info("Starting AI execution", {
        model,
        sandboxId,
        promptLength: prompt.length,
        imageCount: images.length,
      });

      // Build multimodal user content if images are attached
      const buildUserMessage = (text: string, includeImages: boolean = false): UserModelMessage => {
        if (!includeImages || images.length === 0) {
          return { role: "user", content: text };
        }
        
        // Multimodal content with images
        const contentParts: Array<{ type: "text"; text: string } | { type: "image"; image: string; mediaType?: string }> = [
          { type: "text", text: text }
        ];
        
        // Add images
        for (const img of images) {
          contentParts.push({
            type: "image",
            image: img.base64,
            mediaType: img.mimeType, // AI SDK uses mediaType, not mimeType
          });
        }
        
        return { role: "user", content: contentParts };
      };

      // Messages array for multi-turn conversation (AI SDK ModelMessage type)
      const messages: ModelMessage[] = [
        buildUserMessage(contextPrompt, true),
      ];

      let iteration = 0;

      while (iteration < MAX_ITERATIONS) {
        iteration++;
        checkTimeout();
        checkAbort();

        // Stream with tools (no execute functions - SDK v6.0.x pattern)
        // Use fullStream to capture ALL parts including reasoning tokens
        const result = streamText({
          model: gateway.languageModel(model),
          system: finalSystemPrompt,
          messages,
          tools: {
            install_packages: tool({
              description:
                "Install npm packages BEFORE writing files that import them. Always install FIRST.",
              inputSchema: toolSchemas.install_packages,
            }),
            write_file: tool({
              description:
                "Write a file. CRITICAL: Never import local files (@/components/*, etc.) that don't exist yet - write dependencies first! HMR auto-refreshes.",
              inputSchema: toolSchemas.write_file,
            }),
            read_file: tool({
              description: "Read a file's content.",
              inputSchema: toolSchemas.read_file,
            }),
            check_build: tool({
              description:
                "Check build status. Call ONCE at the end, not after each file.",
              inputSchema: toolSchemas.check_build,
            }),
            list_files: tool({
              description: "List files in a directory.",
              inputSchema: toolSchemas.list_files,
            }),
            run_command: tool({
              description:
                "Run a shell command. Database commands (drizzle-kit) automatically have DATABASE_URL injected.",
              inputSchema: toolSchemas.run_command,
            }),
          },
          abortSignal,
        });

        // Use fullStream to capture ALL parts including reasoning/thinking tokens
        // This is CRITICAL for exposing chain-of-thought to the UI
        let assistantText = "";
        let reasoningText = "";

        for await (const part of result.fullStream) {
          checkTimeout();
          checkAbort();

          // Handle known part types
          if (part.type === "text-delta") {
            // Regular text output - property is 'text' in SDK v6
            if (part.text) {
              assistantText += part.text;
              yield { type: "thinking", text: part.text };
              if (callbacks?.onThinking) await callbacks.onThinking(part.text);
            }
          } else if (part.type === "error") {
            logger.error("Stream error", {
              sandboxId,
              error: part.error,
            });
          } else if (part.type === "tool-call") {
            // Tool calls are handled separately below via result.toolCalls
          } else if (
            part.type === "reasoning-start" ||
            part.type === "reasoning-end"
          ) {
            // Reasoning lifecycle events - check for text content
            // Different providers may include reasoning text in different ways
            const partAny = part as Record<string, unknown>;
            if (partAny.text && typeof partAny.text === "string") {
              reasoningText += partAny.text;
              yield { type: "reasoning", text: partAny.text };
              if (callbacks?.onReasoning)
                await callbacks.onReasoning(partAny.text);
            }
          } else {
            // Handle any other reasoning-related types dynamically
            // Some providers may send reasoning content with different type names
            const partAny = part as Record<string, unknown>;
            const partType = String(partAny.type || "");

            if (
              partType.includes("reasoning") ||
              partType.includes("thinking")
            ) {
              // Extract text from reasoning-related parts
              const text =
                (partAny.text as string) ||
                (partAny.textDelta as string) ||
                (partAny.content as string) ||
                "";
              if (text) {
                reasoningText += text;
                yield { type: "reasoning", text };
                if (callbacks?.onReasoning) await callbacks.onReasoning(text);
              }
            }
          }
        }

        // Also check for reasoning in the final result object
        // Some providers/models accumulate reasoning here after streaming completes
        try {
          const resultAny = result as unknown as {
            reasoning?: string | Promise<string>;
            reasoningText?: string | Promise<string>;
          };
          const finalReasoning =
            (await resultAny.reasoning) || (await resultAny.reasoningText);
          if (finalReasoning && typeof finalReasoning === "string") {
            // If we got reasoning from the result that wasn't captured during streaming
            if (!reasoningText.includes(finalReasoning)) {
              reasoningText += finalReasoning;
              yield { type: "reasoning", text: finalReasoning };
              if (callbacks?.onReasoning)
                await callbacks.onReasoning(finalReasoning);
            }
          }
        } catch {
          // Reasoning not available on this result - that's OK
        }

        // Get tool calls (already resolved after fullStream completes)
        const toolCalls = await result.toolCalls;

        // Accumulate reasoning text (chain-of-thought, internal thinking)
        // Only add to reasoning if there's actual reasoningText (CoT tokens)
        // OR if there will be tool calls (intermediate thinking before actions)
        // Don't add assistantText to reasoning if it's the final output (no tool calls)
        const hasToolCalls = toolCalls && toolCalls.length > 0;
        
        if (reasoningText.trim()) {
          // Always capture explicit reasoning/CoT tokens
          allReasoningText += reasoningText.trim() + "\n\n";
        }
        
        if (hasToolCalls && assistantText.trim()) {
          // Only add assistant text to reasoning if there are tool calls
          // (this is intermediate thinking, not final output)
          allReasoningText += assistantText.trim() + "\n\n";
        }

        // Only set outputText from the LAST iteration (when no more tools)
        // This ensures intermediate "thinking" doesn't become final output

        // Execute tools using shared executor
        const toolResults: Array<{ toolName: string; result: string }> = [];
        for (const tc of toolCalls) {
          const tcAny = tc as {
            args?: unknown;
            input?: unknown;
            toolName: string;
          };
          const toolArgs = (tcAny.args ?? tcAny.input ?? {}) as Record<
            string,
            unknown
          >;

          yield {
            type: "tool_call",
            toolName: tc.toolName,
            args: toolArgs,
            reasoningContext: (reasoningText || assistantText) || undefined, // Include reasoning that led to this tool
          };
          if (callbacks?.onToolCall)
            await callbacks.onToolCall(tc.toolName, toolArgs);

          toolCallCount++;

          // Use shared tool executor
          const { result: toolResult, filesAffected: affected } =
            await sharedExecuteToolCall(sandbox, tc.toolName, toolArgs, {
              abortSignal,
              sandboxId,
              appId,
            });

          if (affected) {
            filesAffected.push(...affected);
          }

          toolResults.push({ toolName: tc.toolName, result: toolResult });
          yield {
            type: "tool_result",
            toolName: tc.toolName,
            args: toolArgs,
            result: toolResult,
          };
          if (callbacks?.onToolResult) {
            await callbacks.onToolResult(tc.toolName, toolArgs, toolResult);
          }
        }

        // Continue conversation or finish
        if (toolResults.length > 0) {
          messages.push({
            role: "assistant",
            content: assistantText || "Executing tools...",
          });

          // Build results content with file tracking to prevent duplicate writes
          let resultsContent = toolResults
            .map((tr) => `Tool: ${tr.toolName}\nResult: ${tr.result}`)
            .join("\n\n");

          messages.push({ role: "user", content: resultsContent });
        } else {
          // No tool calls - this is the FINAL iteration
          // Only NOW do we capture the assistant text as final output (if any)
          if (assistantText.trim()) {
            outputText = assistantText.trim();
          }

          // Check if build has errors
          if (filesAffected.length > 0 && iteration < MAX_ITERATIONS - 3) {
            const buildCheck = await checkBuild(sandbox);
            if (buildCheck.includes("BUILD ERRORS")) {
              logger.info("Build errors detected, asking AI to fix", {
                sandboxId,
                iteration,
              });
              messages.push({
                role: "assistant",
                content: assistantText || "Done.",
              });
              messages.push({
                role: "user",
                content: `BUILD ERRORS - fix these:\n\n${buildCheck}`,
              });
              continue;
            }
          }
          break; // Done!
        }
      }

      // Final build check
      if (filesAffected.length > 0) {
        const finalBuild = await checkBuild(sandbox);
        if (finalBuild.includes("BUILD ERRORS")) {
          outputText += `\n\n⚠️ Build errors:\n${finalBuild}`;
        }
      }

      completedNormally = true;

      logger.info("AI execution complete", {
        model,
        sandboxId,
        filesAffected: filesAffected.length,
        toolCallCount,
        iterations: iteration,
        durationMs: Date.now() - startTime,
      });

      // Only include reasoning if it's meaningful and different from output
      // This prevents conversational responses from being hidden in a collapsed accordion
      const finalReasoning = allReasoningText.trim();
      const finalOutput = outputText || "Changes applied!";
      const shouldIncludeReasoning = finalReasoning && 
        finalReasoning !== finalOutput && 
        !finalOutput.includes(finalReasoning) &&
        !finalReasoning.includes(finalOutput);

      yield {
        type: "complete",
        result: {
          output: finalOutput,
          reasoning: shouldIncludeReasoning ? finalReasoning : undefined,
          filesAffected: [...new Set(filesAffected)],
          success: true,
          toolCallCount,
        },
      };
    } catch (error) {
      // IMPORTANT: Even on timeout/error, do a build check if we wrote files
      // This ensures users see any build errors before we exit
      if (!completedNormally && filesAffected.length > 0) {
        try {
          const emergencyBuildCheck = await checkBuild(sandbox);
          if (emergencyBuildCheck.includes("BUILD ERRORS")) {
            outputText += `\n\n⚠️ Build errors detected:\n${emergencyBuildCheck}`;
          }
        } catch {
          // Ignore build check errors during error handling
        }
      }
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.error("AI execution failed", { sandboxId, error: errorMessage });

      yield { type: "error", error: errorMessage };
      
      // Apply same reasoning logic for error case
      const errorFinalReasoning = allReasoningText.trim();
      const errorFinalOutput = outputText || "Operation failed";
      const errorShouldIncludeReasoning = errorFinalReasoning && 
        errorFinalReasoning !== errorFinalOutput && 
        !errorFinalOutput.includes(errorFinalReasoning) &&
        !errorFinalReasoning.includes(errorFinalOutput);
        
      yield {
        type: "complete",
        result: {
          output: errorFinalOutput,
          reasoning: errorShouldIncludeReasoning ? errorFinalReasoning : undefined,
          filesAffected: [...new Set(filesAffected)],
          success: false,
          error: errorMessage,
          toolCallCount,
        },
      };
    }
  }

  /**
   * Execute synchronously (non-streaming) - collects all events and returns final result.
   */
  async execute(
    prompt: string,
    config: AppBuilderConfig,
    callbacks?: AppBuilderStreamCallbacks,
  ): Promise<AppBuilderResult> {
    let finalResult: AppBuilderResult | null = null;
    for await (const event of this.executeStream(prompt, config, callbacks)) {
      if (event.type === "complete") finalResult = event.result;
    }
    return (
      finalResult || {
        output: "No result returned",
        filesAffected: [],
        success: false,
        error: "No result",
        toolCallCount: 0,
      }
    );
  }

  /**
   * Get available models for the UI.
   */
  getAvailableModels() {
    return AVAILABLE_MODELS;
  }

  /**
   * Get the default model ID.
   */
  getDefaultModel() {
    return DEFAULT_MODEL;
  }
}

export const appBuilderAISDK = new AppBuilderAISDK();
