import { Box, Text, render, useApp, useInput, useStdout } from "ink";
import { useEffect, useMemo, useState, type ReactNode } from "react";

type InkKey = {
  upArrow: boolean;
  downArrow: boolean;
  leftArrow: boolean;
  rightArrow: boolean;
  pageDown: boolean;
  pageUp: boolean;
  return: boolean;
  escape: boolean;
  ctrl: boolean;
  shift: boolean;
  tab: boolean;
  backspace: boolean;
  delete: boolean;
  meta: boolean;
  name?: string;
};

type KeySnapshot = {
  input: string;
  ctrl: boolean;
  shift: boolean;
  meta: boolean;
  tab: boolean;
  escape: boolean;
  return: boolean;
  upArrow: boolean;
  downArrow: boolean;
  leftArrow: boolean;
  rightArrow: boolean;
  pageUp: boolean;
  pageDown: boolean;
  backspace: boolean;
  delete: boolean;
  name: string;
  timestamp: number;
};

type ScrollSnapshot = {
  delta: number;
  timestamp: number;
};

type ScrollParseResult = {
  remaining: string;
  delta: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function hasMouseSequence(value: string): boolean {
  return (
    /\x1b\[<\d+;\d+;\d+[mM]/.test(value) ||
    /\x1b\[\d+;\d+;\d+M/.test(value) ||
    /\x1b\[M[\s\S]{3}/.test(value) ||
    /\[<?\d+;\d+;\d+[mM]/.test(value) ||
    /\[M[\s\S]{3}/.test(value)
  );
}

function formatInput(value: string): string {
  if (!value) return "";
  const replaced = value
    .replace(/\x1b/g, "<ESC>")
    .replace(/\t/g, "<TAB>")
    .replace(/\r/g, "<CR>")
    .replace(/\n/g, "<LF>");
  return replaced.length > 120 ? `${replaced.slice(0, 120)}…` : replaced;
}

function formatCharCodes(value: string): string {
  if (!value) return "";
  const codes = Array.from(value).map((char) => char.charCodeAt(0).toString(16).padStart(2, "0"));
  const joined = codes.join(" ");
  return joined.length > 120 ? `${joined.slice(0, 120)}…` : joined;
}

function hasEscPrefix(value: string): boolean {
  return value.startsWith("\x1b");
}

function consumeMouseScroll(buffer: string): ScrollParseResult {
  let delta = 0;
  let lastIndex = 0;
  const sgrPattern = /\x1b\[<(64|65|96|97);(\d+);(\d+)[mM]/g;
  let match = sgrPattern.exec(buffer);
  while (match) {
    // Terminal mouse: 64/96=wheel up, 65/97=wheel down
    delta += match[1] === "64" || match[1] === "96" ? 1 : -1;
    lastIndex = sgrPattern.lastIndex;
    match = sgrPattern.exec(buffer);
  }

  let remaining = buffer;
  if (lastIndex > 0) {
    remaining = buffer.slice(lastIndex);
  }
  const lastEsc = remaining.lastIndexOf("\x1b[<");
  if (lastEsc > 0) {
    remaining = remaining.slice(lastEsc);
  }
  return { remaining, delta };
}

function KeyStateRow({ label, active }: { label: string; active: boolean }): ReactNode {
  return (
    <Text>
      {label.padEnd(10)}: <Text color={active ? "green" : "gray"}>{active ? "ON" : "off"}</Text>
    </Text>
  );
}

function InkInputTestApp(): ReactNode {
  const { exit } = useApp();
  const { stdout } = useStdout();

  const [scrollOffset, setScrollOffset] = useState(0);
  const [scrollSnapshot, setScrollSnapshot] = useState<ScrollSnapshot>({
    delta: 0,
    timestamp: Date.now(),
  });
  const [keySnapshot, setKeySnapshot] = useState<KeySnapshot>(() => ({
    input: "",
    ctrl: false,
    shift: false,
    meta: false,
    tab: false,
    escape: false,
    return: false,
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageUp: false,
    pageDown: false,
    backspace: false,
    delete: false,
    name: "",
    timestamp: Date.now(),
  }));
  const [lastRawInput, setLastRawInput] = useState("");

  const [terminalSize, setTerminalSize] = useState(() => ({
    columns: stdout?.columns ?? 100,
    rows: stdout?.rows ?? 28,
  }));

  const rows = terminalSize.rows;
  const headerHeight = 9;
  const footerHeight = 1;
  const viewHeight = Math.max(5, rows - headerHeight - footerHeight);

  const lines = useMemo(
    () => Array.from({ length: 200 }, (_, idx) => `Line ${String(idx + 1).padStart(3, "0")}`),
    []
  );
  const maxScroll = Math.max(0, lines.length - viewHeight);
  const start = clamp(scrollOffset, 0, maxScroll);
  const visible = lines.slice(start, start + viewHeight);

  useEffect(() => {
    if (!stdout) return;
    const update = () => {
      setTerminalSize({
        columns: stdout.columns ?? 100,
        rows: stdout.rows ?? 28,
      });
    };
    stdout.on("resize", update);
    return () => {
      stdout.off("resize", update);
    };
  }, [stdout]);

  useEffect(() => {
    if (!stdout) return;
    // Enable mouse tracking for scroll events.
    stdout.write("\x1b[?1000h\x1b[?1006h\x1b[?1015h\x1b[?1007l");
    return () => {
      stdout.write("\x1b[?1000l\x1b[?1006l\x1b[?1015l\x1b[?1007l");
    };
  }, [stdout]);

  useEffect(() => {
    const stdin = process.stdin;
    if (!stdin || typeof stdin.on !== "function") return;
    if (typeof stdin.setRawMode === "function") {
      stdin.setRawMode(true);
    }
    if (typeof stdin.resume === "function") {
      stdin.resume();
    }
    let buffer = "";

    const onData = (data: Buffer) => {
      const chunk = data.toString("utf8");
      setLastRawInput(chunk);
      buffer += chunk;
      const scroll = consumeMouseScroll(buffer);
      buffer = scroll.remaining;
      if (scroll.delta === 0) return;
      setScrollSnapshot({ delta: scroll.delta, timestamp: Date.now() });
      setScrollOffset((prev) => clamp(prev + scroll.delta, 0, maxScroll));
    };

    stdin.on("data", onData);
    return () => {
      stdin.off("data", onData);
      if (typeof stdin.setRawMode === "function") {
        stdin.setRawMode(false);
      }
    };
  }, [maxScroll]);

  useInput((input, rawKey) => {
    const key = rawKey as InkKey;
    if (key.ctrl && key.name === "c") {
      exit();
      return;
    }
    if (hasMouseSequence(input)) return;

    setKeySnapshot({
      input,
      ctrl: key.ctrl,
      shift: key.shift,
      meta: key.meta,
      tab: key.tab,
      escape: key.escape,
      return: key.return,
      upArrow: key.upArrow,
      downArrow: key.downArrow,
      leftArrow: key.leftArrow,
      rightArrow: key.rightArrow,
      pageUp: key.pageUp,
      pageDown: key.pageDown,
      backspace: key.backspace,
      delete: key.delete,
      name: key.name ?? "",
      timestamp: Date.now(),
    });
    if (input) {
      setLastRawInput(input);
    }

    if (key.pageUp || key.upArrow) {
      setScrollOffset((prev) => clamp(prev - 1, 0, maxScroll));
      return;
    }
    if (key.pageDown || key.downArrow) {
      setScrollOffset((prev) => clamp(prev + 1, 0, maxScroll));
      return;
    }
  });

  return (
    <Box flexDirection="column" height={rows}>
      <Box flexDirection="column" paddingX={1} height={headerHeight}>
        <Text>Ink Input Test</Text>
        <Text dimColor>
          Scroll offset: {start} / {maxScroll} | Last input: {keySnapshot.input || "(none)"} | Key:
          {keySnapshot.name || "(none)"}
        </Text>
        <Text dimColor>
          Raw input: {formatInput(lastRawInput) || "(none)"} | Codes:{" "}
          {formatCharCodes(lastRawInput) || "(none)"}
        </Text>
        <Text dimColor>
          ESC prefix: {hasEscPrefix(lastRawInput) ? "yes" : "no"} | meta flag:{" "}
          {keySnapshot.meta ? "on" : "off"} | shift flag: {keySnapshot.shift ? "on" : "off"}
        </Text>
        <Text dimColor>
          Last wheel delta: {scrollSnapshot.delta} @ {new Date(scrollSnapshot.timestamp).toLocaleTimeString()}
        </Text>
        <Box flexDirection="row" gap={3}>
          <Box flexDirection="column">
            <KeyStateRow label="ctrl" active={keySnapshot.ctrl} />
            <KeyStateRow label="shift" active={keySnapshot.shift} />
            <KeyStateRow label="meta" active={keySnapshot.meta} />
          </Box>
          <Box flexDirection="column">
            <KeyStateRow label="tab" active={keySnapshot.tab} />
            <KeyStateRow label="escape" active={keySnapshot.escape} />
            <KeyStateRow label="return" active={keySnapshot.return} />
          </Box>
          <Box flexDirection="column">
            <KeyStateRow label="pageUp" active={keySnapshot.pageUp} />
            <KeyStateRow label="pageDown" active={keySnapshot.pageDown} />
            <KeyStateRow label="backspace" active={keySnapshot.backspace} />
          </Box>
          <Box flexDirection="column">
            <KeyStateRow label="up" active={keySnapshot.upArrow} />
            <KeyStateRow label="down" active={keySnapshot.downArrow} />
            <KeyStateRow label="left" active={keySnapshot.leftArrow} />
            <KeyStateRow label="right" active={keySnapshot.rightArrow} />
          </Box>
        </Box>
      </Box>
      <Box flexDirection="column" paddingX={1} height={viewHeight} overflow="hidden">
        {visible.map((line) => (
          <Text key={line}>{line}</Text>
        ))}
      </Box>
      <Box paddingX={1} height={footerHeight}>
        <Text dimColor>Ctrl+C to exit.</Text>
      </Box>
    </Box>
  );
}

export function runInkInputTest(): void {
  render(<InkInputTestApp />);
}
