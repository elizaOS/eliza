import { generateText, type ToolSet, tool } from "ai";
import { z } from "zod";
import { executePostToolFailureHooks, executePostToolHooks, executePreToolHooks } from "../hooks/index";
import { isLspToolEnabled, queryLsp } from "../lsp/runtime";
import { LSP_TOOL_OPERATIONS } from "../lsp/types";
import type { BashTool } from "../tools/bash";
import {
  computerClick,
  computerFocusWindow,
  computerGet,
  computerLaunch,
  computerListWindows,
  computerMouseMove,
  computerPress,
  computerScreenshot,
  computerScroll,
  computerSnapshot,
  computerType,
  computerWait,
} from "../tools/computer";
import { editFile, readFile, writeFile } from "../tools/file";
import { buildCamsnapFileName, resolveCamsnapOutputPath, runCamsnap } from "../tools/camsnap";
import { executeGrep } from "../tools/grep";
import type { ScheduleDaemonStatus, ScheduleManager, StoredSchedule } from "../tools/schedule";
import type { AgentMode, TaskRequest, ToolResult } from "../types/index";
import { type CustomSubagentConfig, loadPaymentSettings, loadValidSubAgents } from "../utils/settings";
import type { XaiProvider } from "./client";
import {
  type GenerateImageToolInput,
  type GenerateVideoToolInput,
  generateImageTool,
  generateVideoTool,
  IMAGE_ASPECT_RATIOS,
  IMAGE_RESOLUTIONS,
  VIDEO_ASPECT_RATIOS,
  VIDEO_RESOLUTIONS,
} from "./media";

const RESPONSES_SEARCH_MODEL = process.env.GROK_MODEL || "grok-4.3";

interface CreateToolsOptions {
  runTask?: (request: TaskRequest, abortSignal?: AbortSignal) => Promise<ToolResult>;
  runDelegation?: (request: TaskRequest, abortSignal?: AbortSignal) => Promise<ToolResult>;
  readDelegation?: (id: string) => Promise<ToolResult>;
  listDelegations?: () => Promise<ToolResult>;
  scheduleManager?: ScheduleManager;
  subagents?: CustomSubagentConfig[];
  sendTelegramFile?: (filePath: string) => Promise<ToolResult>;
  sessionId?: string;
  toolsets?: string[];
}

export function createTools(
  bash: BashTool,
  provider: XaiProvider,
  mode: AgentMode = "agent",
  options: CreateToolsOptions = {},
) {
  const cwd = () => bash.getCwd();
  const enabledToolsets = new Set((options.toolsets ?? []).map((toolset) => toolset.trim().toLowerCase()));

  const runResponsesSearch = async (
    query: string,
    toolName: "web_search" | "x_search",
    abortSignal?: AbortSignal,
  ): Promise<{ success: boolean; output: string }> => {
    if (!provider.responses || !provider.tools) {
      const label = toolName === "web_search" ? "Web search" : "X search";
      return {
        success: false,
        output: `${label} requires the native xAI provider. Re-run with --provider xai and an XAI_API_KEY.`,
      };
    }

    try {
      const searchTools = {
        ...(toolName === "web_search" ? { web_search: provider.tools.webSearch() } : {}),
        ...(toolName === "x_search" ? { x_search: provider.tools.xSearch() } : {}),
      } as unknown as ToolSet;

      const { text } = await generateText({
        model: provider.responses(RESPONSES_SEARCH_MODEL),
        maxOutputTokens: 4096,
        prompt: query,
        abortSignal,
        tools: searchTools,
      });

      return {
        success: true,
        output: text || "No search results found.",
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const label = toolName === "web_search" ? "Web search" : "X search";
      return { success: false, output: `${label} failed: ${msg}` };
    }
  };

  const base = {
    bash: tool({
      description: bash.getToolDescription(),
      inputSchema: z.object({
        command: z.string().describe("The bash command to execute"),
        timeout: z
          .number()
          .optional()
          .describe(
            "Timeout in milliseconds (default: 30000). Use higher values for long-running commands. Ignored when background=true.",
          ),
        background: z
          .boolean()
          .optional()
          .describe(
            "Run the command as a background process. Returns immediately with a process ID. Use process_logs/process_stop/process_list to manage it.",
          ),
      }),
      execute: async ({ command, timeout, background }, { abortSignal }) => {
        const toolInput = { command, timeout, background };
        const preResult = await executePreToolHooks("bash", toolInput, cwd(), options.sessionId, abortSignal);
        if (preResult.blocked) {
          const reason = preResult.blockingErrors.map((e) => e.stderr).join("; ") || "Blocked by hook";
          return { success: false, output: `[Hook blocked] ${reason}` };
        }

        if (background) {
          return bash.startBackground(command);
        }

        const result = await bash.execute(command, timeout, abortSignal);
        const output = {
          success: result.success,
          output: result.success
            ? result.output || "Command executed successfully (no output)"
            : result.error || "Command failed",
        };

        if (result.success) {
          executePostToolHooks("bash", toolInput, output, cwd(), options.sessionId, abortSignal).catch(() => {});
        } else {
          executePostToolFailureHooks(
            "bash",
            toolInput,
            result.error || "Command failed",
            cwd(),
            options.sessionId,
            abortSignal,
          ).catch(() => {});
        }

        return output;
      },
    }),

    process_logs: tool({
      description:
        "View recent output (stdout + stderr) from a background process by its ID. Returns the last N lines of the log.",
      inputSchema: z.object({
        id: z.number().describe("The background process ID"),
        tail: z.number().optional().describe("Number of lines to return from the end (default: 50)"),
      }),
      execute: async ({ id, tail }) => {
        return bash.getProcessLogs(id, tail);
      },
    }),

    process_stop: tool({
      description:
        "Stop a running background process by its ID. Sends SIGTERM, then SIGKILL after 3 seconds if still alive.",
      inputSchema: z.object({
        id: z.number().describe("The background process ID to stop"),
      }),
      execute: async ({ id }) => {
        return bash.stopProcess(id);
      },
    }),

    process_list: tool({
      description: "List all background processes with their ID, status, PID, age, and command.",
      inputSchema: z.object({}),
      execute: async () => {
        return bash.listProcesses();
      },
    }),

    read_file: tool({
      description:
        "Read the contents of a file. Returns numbered lines with a header showing the range and total line count. Use start_line/end_line to read specific sections of large files iteratively.",
      inputSchema: z.object({
        path: z.string().describe("File path (relative to cwd or absolute)"),
        start_line: z.number().optional().describe("First line to read (1-indexed, default: 1)"),
        end_line: z.number().optional().describe("Last line to read (inclusive, default: end of file)"),
      }),
      execute: async ({ path, start_line, end_line }) => {
        return readFile(path, cwd(), start_line, end_line);
      },
    }),

    grep: tool({
      description:
        'Fast content search tool that works with any codebase size. Searches file contents using regular expressions. Supports full regex syntax (e.g. "log.*Error", "function\\s+\\w+"). Filter files by pattern with the include parameter (e.g. "*.js", "*.{ts,tsx}"). Returns matching file paths and line numbers sorted by modification time. Use this tool when you need to find files containing specific patterns. If you need to count matches within files, use bash with `rg` directly.',
      inputSchema: z.object({
        pattern: z.string().describe("The regex pattern to search for in file contents"),
        path: z
          .string()
          .optional()
          .describe("The directory or file to search in. Defaults to the current working directory."),
        include: z.string().optional().describe('File pattern to include in the search (e.g. "*.js", "*.{ts,tsx}")'),
      }),
      execute: async ({ pattern, path, include }) => {
        return executeGrep({ pattern, path, include }, cwd());
      },
    }),

    search_web: tool({
      description:
        "Search the web for current information, documentation, APIs, tutorials, news, or any real-time data. Returns summarized results with sources.",
      inputSchema: z.object({
        query: z.string().describe("The search query"),
      }),
      execute: async ({ query }, { abortSignal }) => {
        return runResponsesSearch(query, "web_search", abortSignal);
      },
    }),

    search_x: tool({
      description:
        "Search X (Twitter) for real-time posts, discussions, opinions, and trends. Returns relevant posts with authors and engagement data.",
      inputSchema: z.object({
        query: z.string().describe("The search query"),
      }),
      execute: async ({ query }, { abortSignal }) => {
        return runResponsesSearch(query, "x_search", abortSignal);
      },
    }),

    generate_image: tool({
      description:
        "Generate a new image or edit an existing image using Grok Imagine. Use when the user asks to create, redesign, restyle, or modify an image. Optionally pass a local file path or public URL in source to edit an existing image. Saves the generated image files locally and returns their paths.",
      inputSchema: z.object({
        prompt: z.string().describe("Prompt describing the image to generate or the edit to apply"),
        source: z
          .string()
          .optional()
          .describe("Optional local image path or public image URL to use as the source for editing"),
        aspect_ratio: z
          .enum(IMAGE_ASPECT_RATIOS)
          .optional()
          .describe("Optional output aspect ratio. Use when the user requests a specific format."),
        resolution: z.enum(IMAGE_RESOLUTIONS).optional().describe("Optional output resolution: 1k or 2k"),
        n: z.number().int().min(1).max(10).optional().describe("Number of images to generate (default: 1)"),
        output_path: z
          .string()
          .optional()
          .describe("Optional file path for the generated image. For multiple images, numbered suffixes are added."),
      }),
      execute: async (input: GenerateImageToolInput, { abortSignal }) => {
        if (!provider.image) {
          return {
            success: false,
            output: "Image generation requires the native xAI provider. Re-run with --provider xai and an XAI_API_KEY.",
          };
        }
        return generateImageTool(provider, input, cwd(), abortSignal);
      },
    }),

    generate_video: tool({
      description:
        "Generate a new short video or animate an existing image using Grok Imagine Video. Use when the user asks for a clip, animation, cinematic shot, or motion from a still image. Optionally pass a local image path or public image URL in source for image-to-video generation. Saves the generated video files locally and returns their paths.",
      inputSchema: z.object({
        prompt: z.string().describe("Prompt describing the video or motion to generate"),
        source: z
          .string()
          .optional()
          .describe("Optional local image path or public image URL to use as the starting frame"),
        duration: z.number().int().min(1).max(15).optional().describe("Video duration in seconds (1-15)"),
        aspect_ratio: z
          .enum(VIDEO_ASPECT_RATIOS)
          .optional()
          .describe("Optional output aspect ratio for text-to-video or to override image-to-video framing"),
        resolution: z.enum(VIDEO_RESOLUTIONS).optional().describe("Optional output resolution: 480p or 720p"),
        output_path: z
          .string()
          .optional()
          .describe("Optional file path for the generated video. For multiple videos, numbered suffixes are added."),
        poll_interval_ms: z
          .number()
          .int()
          .min(100)
          .optional()
          .describe("Optional polling interval in milliseconds while waiting for video generation"),
        poll_timeout_ms: z
          .number()
          .int()
          .min(1000)
          .optional()
          .describe("Optional timeout in milliseconds while waiting for video generation"),
      }),
      execute: async (input: GenerateVideoToolInput, { abortSignal }) => {
        if (!provider.video) {
          return {
            success: false,
            output: "Video generation requires the native xAI provider. Re-run with --provider xai and an XAI_API_KEY.",
          };
        }
        return generateVideoTool(provider, input, cwd(), abortSignal);
      },
    }),
  };

  const tools: ToolSet = { ...base };

  if (enabledToolsets.has("camsnap")) {
    tools.camsnap_discover = tool({
      description:
        "Discover configured or visible cameras using camsnap. Use this before snapping or recording when the camera name is unknown.",
      inputSchema: z.object({
        info: z.boolean().optional().describe("Include detailed camera info. Defaults to true."),
      }),
      execute: async ({ info }, { abortSignal }) => {
        return runCamsnap(["discover", ...(info === false ? [] : ["--info"])], {
          cwd: cwd(),
          timeoutMs: 30_000,
          abortSignal,
        });
      },
    });

    tools.camsnap_doctor = tool({
      description:
        "Run camsnap diagnostics. Use when camera capture fails, ffmpeg is missing, or the camera config may be invalid.",
      inputSchema: z.object({
        probe: z.boolean().optional().describe("Probe cameras and ffmpeg in addition to static diagnostics."),
      }),
      execute: async ({ probe }, { abortSignal }) => {
        return runCamsnap(["doctor", ...(probe ? ["--probe"] : [])], {
          cwd: cwd(),
          timeoutMs: 45_000,
          abortSignal,
        });
      },
    });

    tools.camsnap_snap = tool({
      description:
        "Capture one still image from a configured camera with camsnap. Prefer a short test capture before asking for longer clips.",
      inputSchema: z.object({
        camera: z.string().describe("Camera name or id from camsnap config/discover"),
        output_path: z.string().optional().describe("Optional output image path. Defaults to .clawd/camsnap/*.jpg."),
      }),
      execute: async ({ camera, output_path }, { abortSignal }) => {
        const outputPath = resolveCamsnapOutputPath(cwd(), output_path, buildCamsnapFileName(camera, "jpg"));
        const result = await runCamsnap(["snap", camera, "--out", outputPath], {
          cwd: cwd(),
          timeoutMs: 45_000,
          abortSignal,
        });
        return result.success ? { ...result, output: `${result.output}\nSaved: ${outputPath}` } : result;
      },
    });

    tools.camsnap_clip = tool({
      description:
        "Record a short video clip from a configured camera with camsnap. Keep duration short unless the user explicitly asks for longer.",
      inputSchema: z.object({
        camera: z.string().describe("Camera name or id from camsnap config/discover"),
        duration: z.string().optional().describe("Clip duration such as 5s or 10s. Defaults to 5s."),
        output_path: z.string().optional().describe("Optional output video path. Defaults to .clawd/camsnap/*.mp4."),
      }),
      execute: async ({ camera, duration, output_path }, { abortSignal }) => {
        const outputPath = resolveCamsnapOutputPath(cwd(), output_path, buildCamsnapFileName(camera, "mp4"));
        const clipDuration = duration || "5s";
        const result = await runCamsnap(["clip", camera, "--dur", clipDuration, "--out", outputPath], {
          cwd: cwd(),
          timeoutMs: 120_000,
          abortSignal,
        });
        return result.success ? { ...result, output: `${result.output}\nSaved: ${outputPath}` } : result;
      },
    });

    tools.camsnap_watch = tool({
      description:
        "Run a bounded camsnap motion watch for one camera. Use only when the user explicitly asks to monitor for motion.",
      inputSchema: z.object({
        camera: z.string().describe("Camera name or id from camsnap config/discover"),
        threshold: z.number().min(0).max(1).optional().describe("Motion threshold. Defaults to 0.2."),
        action: z.string().optional().describe("Optional camsnap action command to run on motion."),
        timeout_ms: z.number().int().min(1000).max(300000).optional().describe("Maximum watch time. Defaults to 60000."),
      }),
      execute: async ({ camera, threshold, action, timeout_ms }, { abortSignal }) => {
        const args = ["watch", camera, "--threshold", String(threshold ?? 0.2)];
        if (action) args.push("--action", action);
        return runCamsnap(args, {
          cwd: cwd(),
          timeoutMs: timeout_ms ?? 60_000,
          abortSignal,
        });
      },
    });
  }

  if (isLspToolEnabled(cwd())) {
    tools.lsp = tool({
      description:
        "Experimental Language Server Protocol access for semantic code intelligence. Use for go-to-definition, references, hover, symbols, implementations, and call hierarchy when a matching LSP server is available.",
      inputSchema: z.object({
        operation: z.enum(LSP_TOOL_OPERATIONS).describe("The LSP operation to perform"),
        filePath: z.string().describe("The absolute or cwd-relative path to the target file"),
        line: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            "The 1-based line number. Required for position-based operations (definition, references, hover, implementation, callHierarchy). Not needed for documentSymbol or workspaceSymbol.",
          ),
        character: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            "The 1-based character offset. Required for position-based operations. Not needed for documentSymbol or workspaceSymbol.",
          ),
        query: z.string().optional().describe("Optional symbol query. Used primarily with workspaceSymbol."),
      }),
      execute: async ({ operation, filePath, line, character, query }) => {
        try {
          return await queryLsp(cwd(), {
            operation,
            filePath,
            line: line ?? 1,
            character: character ?? 1,
            query,
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            success: false,
            output: `LSP query failed: ${msg}`,
          };
        }
      },
    });
  }

  if (options.sendTelegramFile) {
    const sendFile = options.sendTelegramFile;
    tools.telegram_send_file = tool({
      description:
        "Send a local file to the current Telegram chat as an attachment. Use this to deliver generated images, videos, documents, or any other file to the user in Telegram. The file is uploaded directly — the user receives it as a Telegram media message or document.",
      inputSchema: z.object({
        path: z.string().describe("Absolute or cwd-relative path to the local file to send"),
      }),
      execute: async ({ path: filePath }) => {
        const resolved = filePath.startsWith("/") ? filePath : `${cwd()}/${filePath}`;
        return sendFile(resolved);
      },
    });
  }

  if (options.runTask) {
    const customNames = (options.subagents ?? loadValidSubAgents()).map((agent) => agent.name);
    const taskAgentEnum = [
      "general",
      "explore",
      "vision",
      "verify",
      "verify-detect",
      "verify-manifest",
      "computer",
      ...customNames,
    ] as [string, ...string[]];
    const customHint =
      customNames.length > 0
        ? ` You may also use these user-defined sub-agents by exact name: ${customNames.join(", ")}.`
        : "";

    tools.task = tool({
      description: `Delegate a focused foreground task to a sub-agent. Prefer this proactively for review, research, investigation, code quality work, verification, and computer-use flows instead of waiting for the user to request a sub-agent. Use \`general\` for multi-step execution, \`explore\` for fast read-only investigation, \`vision\` for image validation, \`verify\` for sandbox-aware build, test, and smoke validation, \`verify-detect\` for read-only verification recipe detection, \`verify-manifest\` to create or update a verification manifest, and \`computer\` for host desktop screenshot/input workflows.${customHint} Provide a short description plus a detailed prompt for the child agent.`,
      inputSchema: z.object({
        agent: z
          .enum(taskAgentEnum)
          .default("general")
          .describe(
            customNames.length > 0
              ? "Built-in general, explore, vision, verify, verify-detect, verify-manifest, or computer, or a configured custom sub-agent name from user settings"
              : "Which sub-agent to use",
          ),
        description: z.string().describe("A short label for the delegated task, such as 'Deep code quality analysis'"),
        prompt: z.string().describe("Detailed instructions for the sub-agent to complete"),
      }),
      execute: async ({ agent, description, prompt }, { abortSignal }) => {
        return options.runTask!({ agent, description, prompt }, abortSignal);
      },
    });
  }

  if (mode === "agent") {
    tools.computer_snapshot = tool({
      description:
        "Capture a semantic accessibility snapshot of a desktop app using agent-desktop. Prefer this before desktop interaction. It returns stable refs like @e1 that remain valid until the next snapshot.",
      inputSchema: z.object({
        app: z.string().optional().describe("Optional application name to scope the snapshot"),
        window_id: z.string().optional().describe("Optional window id from computer_list_windows"),
        interactive_only: z
          .boolean()
          .optional()
          .describe("If true or omitted, include only interactive elements with refs"),
        include_bounds: z.boolean().optional().describe("Include element bounds in the snapshot"),
        compact: z.boolean().optional().describe("Collapse single-child unnamed nodes to reduce tree depth"),
        max_depth: z.number().int().min(1).max(30).optional().describe("Maximum tree depth"),
        surface: z
          .enum(["window", "focused", "menu", "menubar", "sheet", "popover", "alert"])
          .optional()
          .describe("Optional UI surface to snapshot"),
      }),
      execute: async (input, { abortSignal }) => {
        return computerSnapshot(input, cwd(), abortSignal);
      },
    });

    tools.computer_screenshot = tool({
      description:
        "Capture a PNG screenshot of a desktop app window using agent-desktop. Use for visual confirmation or when the accessibility snapshot is insufficient.",
      inputSchema: z.object({
        output_path: z
          .string()
          .optional()
          .describe("Optional output path for the screenshot. Defaults to .clawd/computer/*.png"),
        app: z.string().optional().describe("Optional application name to capture"),
        window_id: z.string().optional().describe("Optional window id from computer_list_windows"),
      }),
      execute: async (input, { abortSignal }) => {
        return computerScreenshot(input, cwd(), abortSignal);
      },
    });

    tools.computer_click = tool({
      description:
        "Click a desktop element via agent-desktop. Prefer `ref` values from computer_snapshot. Coordinates are a fallback only when accessibility refs are unavailable.",
      inputSchema: z.object({
        ref: z.string().optional().describe("Element ref from computer_snapshot, such as @e3"),
        x: z.number().optional().describe("Fallback absolute screen X coordinate"),
        y: z.number().optional().describe("Fallback absolute screen Y coordinate"),
        button: z.enum(["left", "right", "middle"]).optional().describe("Mouse button to click"),
        count: z.number().int().min(1).max(3).optional().describe("Number of clicks"),
      }),
      execute: async (input, { abortSignal }) => {
        return computerClick(input, cwd(), abortSignal);
      },
    });

    tools.computer_mouse_move = tool({
      description: "Hover over a desktop element or coordinates via agent-desktop. Prefer refs from computer_snapshot.",
      inputSchema: z.object({
        ref: z.string().optional().describe("Element ref from computer_snapshot, such as @e3"),
        x: z.number().optional().describe("Fallback absolute screen X coordinate"),
        y: z.number().optional().describe("Fallback absolute screen Y coordinate"),
        duration_ms: z.number().int().min(0).optional().describe("Optional hover duration in milliseconds"),
      }),
      execute: async (input, { abortSignal }) => {
        return computerMouseMove(input, cwd(), abortSignal);
      },
    });

    tools.computer_type = tool({
      description:
        "Type text into a specific desktop element via agent-desktop. Pass a ref from computer_snapshot. For shortcuts like cmd+k or enter, prefer computer_press.",
      inputSchema: z.object({
        ref: z.string().describe("Element ref from computer_snapshot, such as @e5"),
        text: z.string().describe("Text to type"),
      }),
      execute: async (input, { abortSignal }) => {
        return computerType(input, cwd(), abortSignal);
      },
    });

    tools.computer_press = tool({
      description: "Press a key or key chord via agent-desktop, optionally targeting a specific app first.",
      inputSchema: z.object({
        key: z.string().describe("Key or key chord such as enter or cmd+s"),
        app: z.string().optional().describe("Optional application name to focus before pressing"),
      }),
      execute: async (input, { abortSignal }) => {
        return computerPress(input, cwd(), abortSignal);
      },
    });

    tools.computer_scroll = tool({
      description: "Scroll a desktop element via agent-desktop. Pass the element ref from computer_snapshot.",
      inputSchema: z.object({
        ref: z.string().describe("Element ref from computer_snapshot, such as @e8"),
        direction: z.enum(["up", "down", "left", "right"]).describe("Scroll direction"),
        amount: z.number().int().min(1).max(100).optional().describe("Optional scroll amount"),
      }),
      execute: async (input, { abortSignal }) => {
        return computerScroll(input, cwd(), abortSignal);
      },
    });

    tools.computer_launch = tool({
      description: "Launch an application by name or bundle id using agent-desktop and wait for its window to appear.",
      inputSchema: z.object({
        app: z.string().describe("Application name or bundle id"),
        timeout_ms: z
          .number()
          .int()
          .min(100)
          .max(120000)
          .optional()
          .describe("Optional launch timeout in milliseconds"),
      }),
      execute: async (input, { abortSignal }) => {
        return computerLaunch(input, cwd(), abortSignal);
      },
    });

    tools.computer_list_windows = tool({
      description:
        "List visible desktop windows using agent-desktop. Use this to discover window ids before focusing or scoping snapshots.",
      inputSchema: z.object({
        app: z.string().optional().describe("Optional application name to filter windows"),
      }),
      execute: async (input, { abortSignal }) => {
        return computerListWindows(input, cwd(), abortSignal);
      },
    });

    tools.computer_focus_window = tool({
      description: "Bring a desktop window to the front using a window id, app name, or title.",
      inputSchema: z.object({
        window_id: z.string().optional().describe("Window id from computer_list_windows"),
        app: z.string().optional().describe("Application name"),
        title: z.string().optional().describe("Partial window title match"),
      }),
      execute: async (input, { abortSignal }) => {
        return computerFocusWindow(input, cwd(), abortSignal);
      },
    });

    tools.computer_wait = tool({
      description:
        "Wait for time, an element ref, a window title, or text to appear using agent-desktop. Use after launches, dialogs, or UI transitions.",
      inputSchema: z.object({
        milliseconds: z
          .number()
          .int()
          .min(0)
          .max(120000)
          .optional()
          .describe("Optional pause duration in milliseconds"),
        element: z.string().optional().describe("Wait until this element ref appears"),
        window: z.string().optional().describe("Wait until a window title appears"),
        text: z.string().optional().describe("Wait until text appears in the accessibility tree"),
        timeout_ms: z.number().int().min(100).max(120000).optional().describe("Timeout for element/window/text waits"),
        app: z.string().optional().describe("Optional app scope for the wait"),
        menu: z.boolean().optional().describe("Wait until a menu is open"),
        menu_closed: z.boolean().optional().describe("Wait until a menu is dismissed"),
      }),
      execute: async (input, { abortSignal }) => {
        return computerWait(input, cwd(), abortSignal);
      },
    });

    tools.computer_get = tool({
      description: "Read a property like text, value, title, bounds, role, or states from a desktop element ref.",
      inputSchema: z.object({
        ref: z.string().describe("Element ref from computer_snapshot, such as @e4"),
        property: z
          .enum(["text", "value", "title", "bounds", "role", "states"])
          .optional()
          .describe("Property to read"),
      }),
      execute: async (input, { abortSignal }) => {
        return computerGet(input, cwd(), abortSignal);
      },
    });

    tools.write_file = tool({
      description:
        "Create or overwrite a file with the given content. Use for creating new files or completely rewriting existing ones. Returns a diff of the changes.",
      inputSchema: z.object({
        path: z.string().describe("File path (relative to cwd or absolute)"),
        content: z.string().describe("The full file content to write"),
      }),
      execute: async ({ path, content }) => {
        return writeFile(path, content, cwd());
      },
    });

    tools.edit_file = tool({
      description:
        "Edit a file by replacing a unique string with new content. The old_string must appear exactly once in the file. Include enough surrounding context lines in old_string to make it unique. Returns a diff of the changes.",
      inputSchema: z.object({
        path: z.string().describe("File path (relative to cwd or absolute)"),
        old_string: z.string().describe("The exact text to find (must be unique in the file)"),
        new_string: z.string().describe("The replacement text"),
      }),
      execute: async ({ path, old_string, new_string }) => {
        return editFile(path, old_string, new_string, cwd());
      },
    });

    if (options.runDelegation) {
      tools.delegate = tool({
        description:
          "Launch a read-only background agent that can keep researching while you continue working. Use this only for `explore` tasks that do not edit files or make shell changes. You will be notified when it completes.",
        inputSchema: z.object({
          agent: z
            .enum(["explore"])
            .default("explore")
            .describe("Background delegations currently support only the read-only explore agent"),
          description: z.string().describe("A short label for the delegation, such as 'OAuth callback research'"),
          prompt: z.string().describe("Detailed instructions for the background agent to complete"),
        }),
        execute: async ({ agent, description, prompt }, { abortSignal }) => {
          return options.runDelegation!({ agent, description, prompt }, abortSignal);
        },
      });
    }

    if (options.readDelegation) {
      tools.delegation_read = tool({
        description:
          "Read the saved output of a background delegation by ID. Use this after a completion notice or when revisiting prior research.",
        inputSchema: z.object({
          id: z.string().describe("The delegation ID, such as 'calm-blue-fox'"),
        }),
        execute: async ({ id }) => {
          return options.readDelegation!(id);
        },
      });
    }

    if (options.listDelegations) {
      tools.delegation_list = tool({
        description:
          "List recent background delegations for the current project. Use sparingly to discover IDs or review prior results, not for repeated polling.",
        inputSchema: z.object({}),
        execute: async () => {
          return options.listDelegations!();
        },
      });
    }

    if (options.scheduleManager) {
      const schedules = options.scheduleManager;

      tools.schedule_create = tool({
        description:
          "Create a recurring or one-time scheduled headless Grok run. Provide a name, the instruction to run, and a cron expression for recurring schedules. Omit cron for an immediate one-time run.",
        inputSchema: z.object({
          name: z.string().describe("Human-readable schedule name"),
          instruction: z.string().describe("The prompt/instruction Grok should run headlessly"),
          cron: z.string().optional().describe("Cron expression for recurring schedules, such as '0 9 * * 1-5'"),
          model: z.string().optional().describe("Optional model override; defaults to the current selected model"),
          directory: z.string().optional().describe("Optional working directory; defaults to the current directory"),
          max_tool_rounds: z.number().int().positive().optional().describe("Optional max tool rounds override"),
        }),
        execute: async ({ name, instruction, cron, model, directory, max_tool_rounds }) => {
          try {
            const result = await schedules.create({
              name,
              instruction,
              cron,
              model,
              directory,
              maxToolRounds: max_tool_rounds,
            });

            const lines = [
              `Schedule created: ${result.schedule.name}`,
              `ID: ${result.schedule.id}`,
              `Type: ${result.schedule.cron ? "recurring" : "one-time"}`,
              `Model: ${result.schedule.model}`,
              `Directory: ${result.schedule.directory}`,
            ];
            if (result.schedule.cron) {
              lines.push(`Cron: ${result.schedule.cron}`);
              lines.push(formatDaemonReminder(result.daemonStatus));
            } else {
              lines.push(`Run started in background${result.startedPid ? ` (pid ${result.startedPid})` : ""}.`);
            }

            return { success: true, output: lines.join("\n") };
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return { success: false, output: `Failed to create schedule: ${msg}` };
          }
        },
      });

      tools.schedule_list = tool({
        description:
          "List all saved schedules, including one-time and recurring runs, along with daemon status and last run time.",
        inputSchema: z.object({}),
        execute: async () => {
          try {
            const [items, daemonStatus] = await Promise.all([schedules.list(), schedules.getDaemonStatus()]);
            if (items.length === 0) {
              return {
                success: true,
                output: `No schedules found.\n${formatDaemonReminder(daemonStatus)}`,
              };
            }

            return {
              success: true,
              output: formatScheduleList(items, daemonStatus),
            };
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return { success: false, output: `Failed to list schedules: ${msg}` };
          }
        },
      });

      tools.schedule_remove = tool({
        description: "Remove a saved schedule and its run logs by schedule id.",
        inputSchema: z.object({
          id: z.string().describe("Schedule id, such as 'daily-security-scan'"),
        }),
        execute: async ({ id }) => {
          try {
            const removed = await schedules.remove(id);
            if (!removed) {
              return { success: false, output: `Schedule "${id}" not found.` };
            }
            return {
              success: true,
              output: `Removed schedule "${removed.name}" (${removed.id}).`,
            };
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return { success: false, output: `Failed to remove schedule: ${msg}` };
          }
        },
      });

      tools.schedule_read_log = tool({
        description: "Read recent log output from a saved schedule.",
        inputSchema: z.object({
          id: z.string().describe("Schedule id, such as 'daily-security-scan'"),
          tail: z.number().int().positive().optional().describe("Number of log lines to return from the end"),
        }),
        execute: async ({ id, tail }) => {
          try {
            return {
              success: true,
              output: await schedules.readLog(id, tail ?? 50),
            };
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return { success: false, output: `Failed to read schedule log: ${msg}` };
          }
        },
      });

      tools.schedule_daemon_status = tool({
        description: "Check whether the schedule daemon is currently running.",
        inputSchema: z.object({}),
        execute: async () => {
          try {
            const status = await schedules.getDaemonStatus();
            return {
              success: true,
              output: formatDaemonReminder(status),
            };
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return { success: false, output: `Failed to get schedule daemon status: ${msg}` };
          }
        },
      });

      tools.schedule_daemon_start = tool({
        description:
          "Start the schedule daemon in the background so recurring schedules can run even after the TUI closes.",
        inputSchema: z.object({}),
        execute: async () => {
          try {
            const result = await schedules.startDaemon();
            return {
              success: true,
              output: result.alreadyRunning
                ? `Schedule daemon already running${result.status.pid ? ` (pid ${result.status.pid})` : ""}.`
                : `Schedule daemon started${result.pid ? ` (pid ${result.pid})` : ""}.`,
            };
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return { success: false, output: `Failed to start schedule daemon: ${msg}` };
          }
        },
      });

      tools.schedule_daemon_stop = tool({
        description: "Stop the background schedule daemon.",
        inputSchema: z.object({}),
        execute: async () => {
          try {
            const result = await schedules.stopDaemon();
            return {
              success: true,
              output: result.wasRunning
                ? `Schedule daemon stopped${result.pid ? ` (pid ${result.pid})` : ""}.`
                : "Schedule daemon is not running.",
            };
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return { success: false, output: `Failed to stop schedule daemon: ${msg}` };
          }
        },
      });
    }
  }

  tools.wallet_info = tool({
    description:
      "Get the local wallet address, chain, and current balances (ETH and USDC). Use this to check available funds before making a payment.",
    inputSchema: z.object({}),
    execute: async () => {
      try {
        const { WalletManager } = await import("../wallet/manager");
        if (!WalletManager.exists()) {
          return { success: false, output: "No wallet found. Run `grok wallet init` to create one." };
        }
        const wm = new WalletManager();
        const balance = await wm.getBalance();
        return {
          success: true,
          output: [
            `Address: ${balance.address}`,
            `Chain: ${balance.chain}`,
            `ETH: ${balance.nativeBalance}`,
            `USDC: ${balance.usdcBalance}`,
          ].join("\n"),
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, output: `Failed to get wallet info: ${msg}` };
      }
    },
  });

  tools.wallet_history = tool({
    description:
      "Show recent x402 payment history from the local audit log. Returns the most recent payment attempts with status, URL, amount, and transaction hash.",
    inputSchema: z.object({
      limit: z.number().optional().describe("Number of recent entries to return (default: 10)"),
    }),
    execute: async ({ limit }) => {
      try {
        const { PaymentHistory } = await import("../payments/history");
        const history = new PaymentHistory();
        const entries = history.list(limit ?? 10);
        if (entries.length === 0) {
          return { success: true, output: "No payment history yet." };
        }
        const lines = entries.map((e) => {
          const parts = [
            `${e.createdAt}  ${e.status}`,
            `  ${e.method} ${e.url}`,
            `  ${e.amount} ${e.asset} on ${e.network}`,
          ];
          if (e.txHash) parts.push(`  tx: ${e.txHash}`);
          return parts.join("\n");
        });
        return { success: true, output: lines.join("\n\n") };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, output: `Failed to read payment history: ${msg}` };
      }
    },
  });

  tools.fetch_payment_info = tool({
    description:
      "Inspect a URL for x402 payment requirements without paying. Returns payment options and a brin security scan with score, sub-scores (identity, behavior, content, graph), and any detected threats. Use this only when the user wants to inspect without paying — for actual access, call paid_request directly instead.",
    inputSchema: z.object({
      url: z.string().url().describe("The URL to inspect"),
      method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]).optional().describe("HTTP method (default: GET)"),
      headers: z.record(z.string(), z.string()).optional().describe("Optional HTTP headers"),
      body: z.string().optional().describe("Optional request body for POST/PUT/PATCH"),
    }),
    execute: async ({ url, method, headers, body }) => {
      try {
        const { X402Service, formatInspectionOutput } = await import("../payments/service");
        const service = new X402Service();
        const inspection = await service.fetchPaymentInfo({ url, method, headers, body });
        return {
          success: true,
          output: formatInspectionOutput(inspection),
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          output: `Failed to inspect payment info: ${msg}`,
        };
      }
    },
  });

  tools.paid_request = tool({
    description:
      "Access an x402-protected URL using the local wallet. URLs scoring below 25 on brin are automatically blocked. The user will be prompted to approve the payment before it executes.",
    inputSchema: z.object({
      url: z.string().url().describe("The URL to access"),
      method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]).optional().describe("HTTP method (default: GET)"),
      headers: z.record(z.string(), z.string()).optional().describe("Optional HTTP headers"),
      body: z.string().optional().describe("Optional request body for POST/PUT/PATCH"),
    }),
    needsApproval: () => {
      try {
        const approval = loadPaymentSettings().approval;
        return !(typeof approval === "object" && approval !== null && approval.autoApprove === true);
      } catch {
        return true;
      }
    },
    execute: async ({ url, method, headers, body }) => {
      try {
        const { X402Service } = await import("../payments/service");
        const service = new X402Service();
        return await service.paidRequest({ url, method, headers, body }, options.sessionId);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          output: `Failed to access paid URL: ${msg}`,
        };
      }
    },
  });

  if (mode !== "plan") return tools;

  tools.generate_plan = tool({
    description:
      "Generate an interactive implementation plan with steps and optional questions for the user. The plan is displayed in a structured UI where the user can review steps and answer questions. Always use this tool when creating plans.",
    inputSchema: z.object({
      title: z.string().describe("Plan title"),
      summary: z.string().describe("Brief summary of what the plan accomplishes"),
      steps: z
        .array(
          z.object({
            title: z.string().describe("Step title"),
            description: z.string().describe("Detailed description of what this step involves"),
            filePaths: z.array(z.string()).optional().describe("Files affected by this step"),
          }),
        )
        .describe("Ordered list of implementation steps"),
      questions: z
        .array(
          z.object({
            id: z.string().describe("Unique question identifier"),
            question: z.string().describe("The question to ask the user"),
            header: z.string().optional().describe("Single-word tab label (e.g. 'Format', 'Storage', 'Testing')"),
            type: z
              .enum(["select", "multiselect", "text"])
              .describe("Question type: select (pick one), multiselect (pick many), or text (free-form)"),
            options: z
              .array(
                z.object({
                  id: z.string().describe("Option identifier"),
                  label: z.string().describe("Option display text"),
                }),
              )
              .optional()
              .describe("Options for select/multiselect questions"),
          }),
        )
        .optional()
        .describe("Questions for the user to answer before proceeding"),
    }),
    execute: async ({ title, summary, steps, questions }) => {
      return {
        success: true,
        output: `Plan "${title}" generated with ${steps.length} steps`,
        plan: { title, summary, steps, questions },
      };
    },
  });

  return tools;
}

function formatScheduleList(schedules: StoredSchedule[], daemonStatus: ScheduleDaemonStatus): string {
  const lines = [
    `Daemon: ${daemonStatus.running ? `running${daemonStatus.pid ? ` (pid ${daemonStatus.pid})` : ""}` : "not running"}`,
  ];

  for (const schedule of schedules) {
    const scheduleType = schedule.cron ? "recurring" : "one-time";
    lines.push("");
    lines.push(`- ${schedule.name} (\`${schedule.id}\`)`);
    lines.push(`  type: ${scheduleType}`);
    if (schedule.cron) {
      lines.push(`  cron: ${schedule.cron}`);
      lines.push(`  enabled: ${schedule.enabled ? "yes" : "no"}`);
    }
    lines.push(`  model: ${schedule.model}`);
    lines.push(`  directory: ${schedule.directory}`);
    lines.push(`  last run: ${schedule.lastRunAt ?? "never"}`);
  }

  if (!daemonStatus.running) {
    lines.push("");
    lines.push("Start `grok daemon` to run recurring schedules.");
  }

  return lines.join("\n");
}

function formatDaemonReminder(status: ScheduleDaemonStatus): string {
  if (status.running) {
    return `Daemon status: running${status.pid ? ` (pid ${status.pid})` : ""}.`;
  }
  return "Daemon status: not running. Use `schedule_daemon_start` (or `grok daemon`) to run recurring schedules.";
}
