import { Box, type Key, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { useEffect, useMemo, useState } from "react";
import { useStore } from "../lib/store.js";
import type { Message } from "../types.js";

interface ChatPaneProps {
  onSendMessage: (text: string) => Promise<void>;
  isFocused: boolean;
  paneWidth: number;
  paneHeight: number;
}

interface CommandSuggestion {
  command: string;
  description: string;
}

const COMMANDS: CommandSuggestion[] = [
  // Conversation commands
  { command: "/new", description: "Start new conversation" },
  { command: "/reset", description: "Reset current conversation" },
  { command: "/conversations", description: "List all conversations" },
  { command: "/chats", description: "List all conversations" },
  { command: "/switch", description: "Switch conversation" },
  { command: "/rename", description: "Rename conversation" },
  { command: "/delete", description: "Delete a conversation" },
  // Agent selection
  { command: "/agent", description: "Select active worker sub-agent" },
  // Task commands
  { command: "/task", description: "Task management" },
  { command: "/task list", description: "List all tasks" },
  { command: "/task switch", description: "Switch to a task" },
  { command: "/task current", description: "Show current task" },
  { command: "/task pause", description: "Pause current task" },
  { command: "/task resume", description: "Resume task" },
  { command: "/task cancel", description: "Cancel a task" },
  { command: "/tasks", description: "List all tasks (shortcut)" },
  // Task pane commands
  { command: "/task pane show", description: "Show tasks pane" },
  { command: "/task pane hide", description: "Hide tasks pane" },
  { command: "/task pane auto", description: "Auto tasks pane" },
  { command: "/task pane toggle", description: "Toggle tasks pane" },
  { command: "/tasks show", description: "Show tasks pane (alias)" },
  { command: "/tasks hide", description: "Hide tasks pane (alias)" },
  { command: "/tasks auto", description: "Auto tasks pane (alias)" },
  { command: "/tasks toggle", description: "Toggle tasks pane (alias)" },
  // Directory commands
  { command: "/cd", description: "Change directory" },
  { command: "/pwd", description: "Show current directory" },
  // Other
  { command: "/clear", description: "Clear chat history" },
  { command: "/help", description: "Show all commands" },
];

interface RenderLine {
  key: string;
  text: string;
  color?: string;
  dimColor?: boolean;
  italic?: boolean;
  bold?: boolean;
}

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

function truncateToWidth(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  if (width <= 3) return text.slice(0, width);
  return `${text.slice(0, width - 3)}...`;
}

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

function toRenderLines(messages: Message[], maxWidth: number): RenderLine[] {
  const lines: RenderLine[] = [];

  for (const msg of messages) {
    const timeStr = formatTime(msg.timestamp);

    if (msg.role === "system") {
      const wrapped = wrapText(msg.content, maxWidth);
      for (let i = 0; i < wrapped.length; i++) {
        lines.push({
          key: `${msg.id}:system:${i}`,
          text: truncateToWidth(wrapped[i], maxWidth),
          dimColor: true,
          italic: true,
        });
      }
      continue;
    }

    const speaker = msg.role === "user" ? "You" : "Eliza";
    const color = msg.role === "user" ? "cyan" : "green";
    const header = `${speaker}${timeStr ? ` ${timeStr}` : ""}`;

    lines.push({
      key: `${msg.id}:header`,
      text: truncateToWidth(header, maxWidth),
      color,
      bold: true,
    });

    const indent = "  ";
    const contentWidth = Math.max(1, maxWidth - indent.length);
    const wrapped = wrapText(msg.content, contentWidth);
    for (let i = 0; i < wrapped.length; i++) {
      lines.push({
        key: `${msg.id}:content:${i}`,
        text: truncateToWidth(indent + wrapped[i], maxWidth),
      });
    }
  }

  return lines;
}

const MAX_VISIBLE_SUGGESTIONS = 8;

export function ChatPane({
  onSendMessage,
  isFocused,
  paneWidth,
  paneHeight,
}: ChatPaneProps) {
  const [scrollOffsetLines, setScrollOffsetLines] = useState(0);
  const [selectedSuggestion, setSelectedSuggestion] = useState(0);

  const {
    rooms,
    currentRoomId,
    isAgentTyping,
    isLoading,
    inputValue,
    setInputValue,
  } = useStore();

  const currentRoom = rooms.find((r) => r.id === currentRoomId);
  const messages = currentRoom?.messages ?? [];

  // Get matching command suggestions (no limit - we'll scroll through them)
  const allSuggestions = useMemo(() => {
    if (!inputValue.startsWith("/")) return [];
    const query = inputValue.toLowerCase();
    return COMMANDS.filter((cmd) =>
      cmd.command.toLowerCase().startsWith(query),
    );
  }, [inputValue]);

  // Calculate visible window of suggestions
  const visibleSuggestions = useMemo(() => {
    if (allSuggestions.length <= MAX_VISIBLE_SUGGESTIONS) {
      return { items: allSuggestions, startIndex: 0 };
    }
    // Keep selected item in view with some context
    const halfWindow = Math.floor(MAX_VISIBLE_SUGGESTIONS / 2);
    let startIndex = Math.max(0, selectedSuggestion - halfWindow);
    const endIndex = Math.min(
      allSuggestions.length,
      startIndex + MAX_VISIBLE_SUGGESTIONS,
    );
    // Adjust start if we're near the end
    if (endIndex - startIndex < MAX_VISIBLE_SUGGESTIONS) {
      startIndex = Math.max(0, endIndex - MAX_VISIBLE_SUGGESTIONS);
    }
    return { items: allSuggestions.slice(startIndex, endIndex), startIndex };
  }, [allSuggestions, selectedSuggestion]);

  const isCommandMode = inputValue.trimStart().startsWith("/");
  const showSuggestions =
    isCommandMode && allSuggestions.length > 0 && !isLoading;

  // Reset selection when suggestions change
  useEffect(() => {
    setSelectedSuggestion(0);
  }, []);

  const paddingX = 1;
  const innerWidth = Math.max(1, paneWidth - paddingX * 2);

  const inputBorderPaddingX = 1;
  const inputInnerWidth = Math.max(1, innerWidth - 2 - inputBorderPaddingX * 2); // border(2) + paddingX

  const wrappedInputLines = useMemo(
    () => wrapText(inputValue, inputInnerWidth),
    [inputValue, inputInnerWidth],
  );

  const inputPreviewLines = useMemo(() => {
    if (isCommandMode) return [];
    if (wrappedInputLines.length <= 1) return [];
    // Show up to the last 2 wrapped lines above the active input line.
    const start = Math.max(0, wrappedInputLines.length - 3);
    return wrappedInputLines.slice(start, wrappedInputLines.length - 1);
  }, [isCommandMode, wrappedInputLines]);

  const allLines = useMemo(() => {
    const base = toRenderLines(messages, innerWidth);
    if (isAgentTyping) {
      base.push({
        key: "typing",
        text: truncateToWidth("Eliza typing…", innerWidth),
        color: "green",
        dimColor: true,
      });
    }
    return base;
  }, [messages, innerWidth, isAgentTyping]);

  // Calculate suggestions height: border(2) + visible items + help(1) + scroll indicators (up to 2)
  const hasScrollUp = visibleSuggestions.startIndex > 0;
  const hasScrollDown =
    visibleSuggestions.startIndex + visibleSuggestions.items.length <
    allSuggestions.length;
  const scrollIndicatorLines = (hasScrollUp ? 1 : 0) + (hasScrollDown ? 1 : 0);
  const suggestionsHeight = showSuggestions
    ? visibleSuggestions.items.length + 3 + scrollIndicatorLines
    : 0;
  const inputHeight = 3 + inputPreviewLines.length; // border(2) + input line + preview lines
  const headerHeight = 1;
  const helpHeight = 1;
  const messageAreaHeight = Math.max(
    1,
    paneHeight - headerHeight - suggestionsHeight - inputHeight - helpHeight,
  );

  const maxScrollOffset = Math.max(0, allLines.length - messageAreaHeight);
  const clampedScrollOffset = Math.min(scrollOffsetLines, maxScrollOffset);

  // Handle input
  useInput(
    (_char: string, key: Key) => {
      if (!isFocused) return;

      // Tab to autocomplete
      if (key.tab && showSuggestions) {
        const selected = allSuggestions[selectedSuggestion];
        if (selected) {
          setInputValue(`${selected.command} `);
        }
        return;
      }

      // Arrow keys to navigate suggestions
      if (showSuggestions) {
        if (key.upArrow && !key.ctrl) {
          setSelectedSuggestion((prev) => Math.max(0, prev - 1));
          return;
        }
        if (key.downArrow && !key.ctrl) {
          setSelectedSuggestion((prev) =>
            Math.min(allSuggestions.length - 1, prev + 1),
          );
          return;
        }
      }

      // Enter to send (or autocomplete if suggestion selected)
      if (key.return && inputValue.trim() && !isLoading) {
        if (showSuggestions && allSuggestions[selectedSuggestion]) {
          // If exact match, send it; otherwise autocomplete
          const selected = allSuggestions[selectedSuggestion];
          if (inputValue.trim() === selected.command) {
            const text = inputValue.trim();
            setInputValue("");
            onSendMessage(text);
          } else {
            setInputValue(`${selected.command} `);
          }
        } else {
          const text = inputValue.trim();
          setInputValue("");
          onSendMessage(text);
        }
        return;
      }

      // Escape to clear input
      if (key.escape) {
        setInputValue("");
        return;
      }

      // Scroll chat history with Ctrl+Up/Down
      if (key.upArrow && key.ctrl) {
        setScrollOffsetLines((prev) => Math.min(prev + 1, maxScrollOffset));
      }
      if (key.downArrow && key.ctrl) {
        setScrollOffsetLines((prev) => Math.max(prev - 1, 0));
      }
    },
    { isActive: isFocused },
  );

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    setScrollOffsetLines(0);
  }, []);

  const visibleLines = useMemo(() => {
    const startIndex = Math.max(
      0,
      allLines.length - messageAreaHeight - clampedScrollOffset,
    );
    const endIndex = Math.max(0, allLines.length - clampedScrollOffset);
    return allLines.slice(startIndex, endIndex);
  }, [allLines, messageAreaHeight, clampedScrollOffset]);

  return (
    <Box
      flexDirection="column"
      height={paneHeight}
      width={paneWidth}
      paddingX={paddingX}
      overflow="hidden"
    >
      {/* Header */}
      <Box overflow="hidden">
        <Text bold color={isFocused ? "cyan" : "white"} wrap="truncate">
          Chat: {currentRoom?.name ?? "Unknown"}{" "}
          <Text dimColor>({messages.length})</Text>
          {clampedScrollOffset > 0 && (
            <Text dimColor> [↑ {clampedScrollOffset}]</Text>
          )}
        </Text>
      </Box>

      {/* Messages */}
      <Box flexDirection="column" height={messageAreaHeight} overflow="hidden">
        {visibleLines.length === 0 ? (
          <Text dimColor italic wrap="truncate">
            No messages.
          </Text>
        ) : (
          visibleLines.map((line) => (
            <Text
              key={line.key}
              color={line.color}
              dimColor={line.dimColor}
              italic={line.italic}
              bold={line.bold}
              wrap="truncate"
            >
              {line.text}
            </Text>
          ))
        )}
      </Box>

      {/* Command suggestions popup */}
      {showSuggestions && (
        <Box
          flexDirection="column"
          borderStyle="single"
          borderColor="cyan"
          paddingX={1}
          marginBottom={0}
        >
          {visibleSuggestions.startIndex > 0 && (
            <Text dimColor>↑ {visibleSuggestions.startIndex}</Text>
          )}
          {visibleSuggestions.items.map((suggestion, idx) => {
            const actualIndex = visibleSuggestions.startIndex + idx;
            const isSelected = actualIndex === selectedSuggestion;
            return (
              <Box key={suggestion.command}>
                <Text
                  color={isSelected ? "cyan" : undefined}
                  bold={isSelected}
                  inverse={isSelected}
                  wrap="truncate"
                >
                  {isSelected ? " ▸ " : "   "}
                  {suggestion.command}
                </Text>
                <Text dimColor wrap="truncate">
                  {" "}
                  {suggestion.description}
                </Text>
              </Box>
            );
          })}
          {visibleSuggestions.startIndex + visibleSuggestions.items.length <
            allSuggestions.length && (
            <Text dimColor>
              ↓{" "}
              {allSuggestions.length -
                visibleSuggestions.startIndex -
                visibleSuggestions.items.length}
            </Text>
          )}
        </Box>
      )}

      {/* Input area - full width */}
      <Box
        flexDirection="column"
        borderStyle="single"
        borderColor={isFocused ? "cyan" : "gray"}
        paddingX={inputBorderPaddingX}
        width={innerWidth}
        overflow="hidden"
      >
        {isLoading ? (
          <Text dimColor>Processing...</Text>
        ) : (
          <>
            {inputPreviewLines.map((line, idx) => (
              <Text key={`preview:${idx}`} dimColor wrap="truncate">
                {truncateToWidth(line, inputInnerWidth)}
              </Text>
            ))}
            <Box
              width={Math.max(1, innerWidth - 2 - inputBorderPaddingX * 2)}
              overflow="hidden"
            >
              <Text color="cyan">{">"} </Text>
              <Box flexGrow={1}>
                <TextInput
                  value={inputValue}
                  onChange={setInputValue}
                  placeholder="Message (or /command)…"
                  focus={isFocused}
                />
              </Box>
            </Box>
          </>
        )}
      </Box>

      {/* Help text */}
      <Box>
        <Text dimColor wrap="truncate">
          {!isFocused
            ? "Tab: focus"
            : isCommandMode
              ? "Enter: run • Tab: complete • Esc: clear • ?: help"
              : "Enter: send • Tab: tasks • Esc: clear • ?: help"}
        </Text>
      </Box>
    </Box>
  );
}
