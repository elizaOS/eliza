import { Box, Text, useStdout } from "ink";
import { useEffect, useMemo, useState } from "react";
import { getCwd } from "../lib/cwd.js";
import { useStore } from "../lib/store.js";

export function StatusBar() {
  const { stdout } = useStdout();
  const terminalWidth = stdout?.columns ?? 80;

  const isLoading = useStore((state) => state.isLoading);
  const tasks = useStore((state) => state.tasks);
  const rooms = useStore((state) => state.rooms);
  const currentRoomId = useStore((state) => state.currentRoomId);

  const currentRoom = useMemo(
    () => rooms.find((r) => r.id === currentRoomId),
    [rooms, currentRoomId],
  );
  const roomIndex = useMemo(
    () => rooms.findIndex((r) => r.id === currentRoomId) + 1,
    [rooms, currentRoomId],
  );

  // Track CWD changes
  const [cwd, setCwdState] = useState(getCwd());

  useEffect(() => {
    const interval = setInterval(() => {
      const currentCwd = getCwd();
      if (currentCwd !== cwd) {
        setCwdState(currentCwd);
      }
    }, 500);
    return () => clearInterval(interval);
  }, [cwd]);

  const taskCounts = useMemo(
    () => ({
      running: tasks.filter((t) => t.metadata?.status === "running").length,
      completed: tasks.filter((t) => t.metadata?.status === "completed").length,
      failed: tasks.filter((t) => t.metadata?.status === "failed").length,
      cancelled: tasks.filter((t) => t.metadata?.status === "cancelled").length,
    }),
    [tasks],
  );

  const showFullRight = terminalWidth >= 80;
  const showMediumRight = terminalWidth >= 60;

  const rightTextPlain = showFullRight
    ? `Tasks r${taskCounts.running} c${taskCounts.completed} f${taskCounts.failed} x${taskCounts.cancelled}${
        isLoading ? " …" : ""
      } | ?`
    : showMediumRight
      ? `Tasks r${taskCounts.running} f${taskCounts.failed}${isLoading ? " …" : ""} | ?`
      : `Tasks r${taskCounts.running}${isLoading ? " …" : ""} | ?`;

  // Calculate available space for CWD (rough; final safety is wrap="truncate")
  const maxCwdLen = Math.max(10, terminalWidth - rightTextPlain.length - 24);

  const shortCwd =
    cwd.length > maxCwdLen ? `...${cwd.slice(-(maxCwdLen - 3))}` : cwd;

  // Truncate room name if too long
  const maxRoomNameLen = 20;
  const roomName = currentRoom?.name ?? "Chat";
  const shortRoomName =
    roomName.length > maxRoomNameLen
      ? `${roomName.slice(0, maxRoomNameLen - 1)}…`
      : roomName;

  return (
    <Box
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
      width={terminalWidth}
      overflow="hidden"
    >
      {/* Left - Conversation + CWD */}
      <Box flexGrow={1} flexShrink={1} overflow="hidden">
        <Text wrap="truncate">
          <Text bold color="magenta">
            {shortRoomName}
          </Text>
          <Text dimColor>
            {" "}
            ({roomIndex}/{rooms.length}) |{" "}
          </Text>
          <Text color="cyan">{shortCwd}</Text>
        </Text>
      </Box>

      {/* Right - fixed content */}
      <Box flexShrink={1} overflow="hidden">
        <Text dimColor wrap="truncate">
          {rightTextPlain}
        </Text>
      </Box>
    </Box>
  );
}
