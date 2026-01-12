import { Box, Text } from "ink";
import { useMemo } from "react";
import type { Message } from "../types.js";

interface MessageBubbleProps {
  message: Message;
  maxWidth?: number;
}

/**
 * Safely format a timestamp to HH:MM format.
 * Handles Date objects, numbers (epoch), and strings.
 */
function formatTime(timestamp: Date | number | string | undefined): string {
  if (!timestamp) return "";

  try {
    let date: Date;
    if (timestamp instanceof Date) {
      date = timestamp;
    } else if (typeof timestamp === "number") {
      date = new Date(timestamp);
    } else if (typeof timestamp === "string") {
      date = new Date(timestamp);
    } else {
      return "";
    }

    // Validate the date is valid
    if (Number.isNaN(date.getTime())) {
      return "";
    }

    return date.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    return "";
  }
}

/**
 * Word-wrap text to fit within a maximum width.
 * This helps ensure text displays correctly in the terminal.
 */
function wrapText(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [text];

  const lines: string[] = [];
  const paragraphs = text.split("\n");

  for (const paragraph of paragraphs) {
    if (paragraph.length <= maxWidth) {
      lines.push(paragraph);
      continue;
    }

    const words = paragraph.split(" ");
    let currentLine = "";

    for (const word of words) {
      if (currentLine.length + word.length + 1 <= maxWidth) {
        currentLine += (currentLine ? " " : "") + word;
      } else {
        if (currentLine) {
          lines.push(currentLine);
        }
        // Handle words longer than maxWidth
        if (word.length > maxWidth) {
          let remaining = word;
          while (remaining.length > maxWidth) {
            lines.push(remaining.substring(0, maxWidth));
            remaining = remaining.substring(maxWidth);
          }
          currentLine = remaining;
        } else {
          currentLine = word;
        }
      }
    }
    if (currentLine) {
      lines.push(currentLine);
    }
  }

  return lines.length > 0 ? lines : [""];
}

export function MessageBubble({ message, maxWidth = 60 }: MessageBubbleProps) {
  const isUser = message.role === "user";
  const isSystem = message.role === "system";

  // Memoize formatted content to prevent re-calculations
  const { displayContent, timeStr } = useMemo(() => {
    // Truncate very long messages for display
    const content =
      message.content.length > 500
        ? `${message.content.substring(0, 500)}...`
        : message.content;

    return {
      displayContent: content,
      timeStr: formatTime(message.timestamp),
    };
  }, [message.content, message.timestamp]);

  // Wrap content for proper display
  const wrappedLines = useMemo(
    () => wrapText(displayContent, maxWidth),
    [displayContent, maxWidth],
  );

  if (isSystem) {
    return (
      <Box flexDirection="column" marginY={0} paddingX={1}>
        {wrappedLines.map((line, i) => (
          <Text key={i} dimColor italic>
            {line}
          </Text>
        ))}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginY={0}>
      <Box>
        <Text bold color={isUser ? "cyan" : "green"}>
          {isUser ? "You" : "Eliza"}
        </Text>
        {timeStr && <Text dimColor> {timeStr}</Text>}
        {message.taskId && (
          <Text dimColor> [Task: {message.taskId.substring(0, 8)}]</Text>
        )}
      </Box>
      <Box flexDirection="column" paddingLeft={2}>
        {wrappedLines.map((line, i) => (
          <Text key={i}>{line}</Text>
        ))}
      </Box>
    </Box>
  );
}
