import { Box, Text } from "ink";

interface HelpOverlayProps {
  width: number;
  height: number;
}

export function HelpOverlay({ width, height }: HelpOverlayProps) {
  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      paddingX={1}
      paddingY={1}
    >
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="cyan"
        paddingX={1}
        paddingY={0}
        width={Math.max(1, width - 2)}
        flexGrow={1}
        overflow="hidden"
      >
        <Text bold color="cyan" wrap="truncate">
          Help
        </Text>

        <Box flexDirection="column" marginTop={0}>
          <Text bold wrap="truncate">
            Navigation
          </Text>
          <Text dimColor wrap="truncate">
            Tab: switch panes (except while typing /command)
          </Text>
          <Text dimColor wrap="truncate">
            Ctrl+&lt; / Ctrl+&gt; (or Ctrl+, / Ctrl+.): resize tasks pane
          </Text>
          <Text dimColor wrap="truncate">
            ?: toggle help
          </Text>
          <Text dimColor wrap="truncate">
            Ctrl+N: new conversation
          </Text>
          <Text dimColor wrap="truncate">
            Ctrl+C / Ctrl+Q: quit
          </Text>
        </Box>

        <Box flexDirection="column" marginTop={1}>
          <Text bold wrap="truncate">
            Chat
          </Text>
          <Text dimColor wrap="truncate">
            Enter: send | Esc: clear | Ctrl+↑↓: scroll
          </Text>
          <Text dimColor wrap="truncate">
            /help: show commands
          </Text>
        </Box>

        <Box flexDirection="column" marginTop={1}>
          <Text bold wrap="truncate">
            Tasks
          </Text>
          <Text dimColor wrap="truncate">
            ↑↓ select | Enter switch | d done/open | f finished | e edit mode
          </Text>
          <Text dimColor wrap="truncate">
            Edit mode: r rename | p pause/resume | c cancel | x delete (y/n
            confirm)
          </Text>
          <Text dimColor wrap="truncate">
            /task pane show|hide|auto|toggle (aliases: /tasks
            show|hide|auto|toggle)
          </Text>
        </Box>

        <Box flexDirection="column" marginTop={1}>
          <Text bold wrap="truncate">
            Commands
          </Text>
          <Text dimColor wrap="truncate">
            /new, /switch, /rename, /delete, /reset
          </Text>
          <Text dimColor wrap="truncate">
            /task, /tasks, /cd, /pwd, /clear
          </Text>
        </Box>

        <Box flexGrow={1} />

        <Text dimColor wrap="truncate">
          Press ? or Esc to close
        </Text>
      </Box>
    </Box>
  );
}
