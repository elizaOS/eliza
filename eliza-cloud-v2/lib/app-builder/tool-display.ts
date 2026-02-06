/**
 * Tool Display Formatter utility
 *
 * Provides consistent formatting for app-builder tool names and details.
 */

export interface ToolDisplayInfo {
  display: string;
  detail: string;
  statusMessage: string;
  /** Optional reasoning/chain-of-thought text */
  reasoning?: string;
}

export interface ToolInput {
  path?: string;
  packages?: string[];
  command?: string;
  [key: string]: unknown;
}

/**
 * Formats tool usage information for display in the UI
 * @param toolName - The raw tool name from the API
 * @param input - The tool input parameters
 * @returns Formatted display information
 */
export function formatToolDisplay(
  toolName: string,
  input?: ToolInput,
): ToolDisplayInfo {
  switch (toolName) {
    case "write_file": {
      const path = input?.path || "file";
      return {
        display: "Writing file",
        detail: path,
        statusMessage: `Writing ${path.split("/").pop()}...`,
      };
    }
    case "read_file": {
      const path = input?.path || "file";
      return {
        display: "Reading file",
        detail: path,
        statusMessage: "Reading file...",
      };
    }
    case "install_packages": {
      const packages = input?.packages?.join(", ") || "packages";
      return {
        display: "Installing packages",
        detail: packages,
        statusMessage: "Installing dependencies...",
      };
    }
    case "check_build":
      return {
        display: "Checking build",
        detail: "Verifying project compiles",
        statusMessage: "Running build check...",
      };
    case "list_files": {
      const path = input?.path || ".";
      return {
        display: "Listing directory",
        detail: path,
        statusMessage: "Exploring project structure...",
      };
    }
    case "run_command": {
      const cmd = input?.command || "command";
      return {
        display: "Running command",
        detail: cmd,
        statusMessage: "Executing command...",
      };
    }
    default:
      return {
        display: toolName.replace(/_/g, " "),
        detail: JSON.stringify(input || {}).slice(0, 50),
        statusMessage: "Working...",
      };
  }
}

/**
 * Creates a timestamp string in HH:MM:SS format
 */
export function getTimeString(): string {
  return new Date().toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export interface ActionLogEntry {
  tool: string;
  detail: string;
  timestamp: string;
  status: "active" | "done";
  /** Optional reasoning/chain-of-thought text explaining why this action was taken */
  reasoning?: string;
}

/**
 * Builds progress content markdown from action log entries
 * @param actionsLog - Array of action log entries
 * @param currentStatus - Optional current status message
 * @param currentReasoning - Optional current reasoning/thinking text
 * @returns Markdown formatted progress content
 */
export function buildProgressContent(
  actionsLog: ActionLogEntry[],
  currentStatus?: string,
  currentReasoning?: string,
): string {
  let content = "**Processing your request**\n\n";

  // Show current reasoning/thinking if available
  if (currentReasoning) {
    content += `💭 *${currentReasoning.substring(0, 200)}${currentReasoning.length > 200 ? "..." : ""}*\n\n`;
  }

  if (actionsLog.length > 0) {
    actionsLog.forEach((action) => {
      const statusMarker = action.status === "active" ? "⏳" : "✓";
      content += `\`${action.timestamp}\` ${statusMarker} **${action.tool}**\n`;
      content += `> \`${action.detail}\`\n`;
      if (action.reasoning) {
        content += `> 💭 *${action.reasoning.substring(0, 100)}${action.reasoning.length > 100 ? "..." : ""}*\n`;
      }
      content += "\n";
    });
  }

  if (currentStatus) {
    content += `---\n\n*${currentStatus}*`;
  }

  return content;
}

/**
 * Builds final completion content markdown
 * @param output - The AI output text
 * @param actionsLog - Array of action log entries
 * @returns Markdown formatted completion content
 */
export function buildCompletionContent(
  output: string | undefined,
  actionsLog: ActionLogEntry[],
): string {
  let content = "";

  if (output) {
    content += output;
  }

  if (actionsLog.length > 0) {
    content += "\n\n---\n\n";
    content += "**Operations Completed**\n\n";
    actionsLog.forEach((action) => {
      content += `\`${action.timestamp}\` ✓ **${action.tool}**\n`;
      content += `> \`${action.detail}\`\n`;
      if (action.reasoning) {
        content += `> 💭 *${action.reasoning.substring(0, 100)}${action.reasoning.length > 100 ? "..." : ""}*\n`;
      }
      content += "\n";
    });
  }

  return content;
}

/**
 * Builds error content markdown
 * @param error - The error object or message
 * @param actionsLog - Array of action log entries
 * @returns Markdown formatted error content
 */
export function buildErrorContent(
  error: Error | string,
  actionsLog: ActionLogEntry[],
): string {
  const errorMessage = error instanceof Error ? error.message : error;
  let content = `**Error:** ${errorMessage}\n\n`;
  content +=
    "The operation could not be completed. Please try again or modify your request.";

  if (actionsLog.length > 0) {
    content += "\n\n---\n\n";
    content += "**Attempted Actions**\n\n";
    actionsLog.forEach((action) => {
      const statusMarker = action.status === "done" ? "✓" : "✗";
      content += `\`${action.timestamp}\` ${statusMarker} **${action.tool}**\n`;
      content += `> \`${action.detail}\`\n\n`;
    });
  }

  return content;
}
