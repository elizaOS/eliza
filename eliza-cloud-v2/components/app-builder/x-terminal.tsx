"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import { Terminal as XTerminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";

interface WebTerminalProps {
  sessionId?: string;
  sandboxUrl?: string;
  disabled?: boolean;
  className?: string;
}

export function WebTerminal({
  sessionId,
  sandboxUrl,
  disabled = false,
  className = "",
}: WebTerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const [commandHistory, setCommandHistory] = useState<string[]>([]);
  const [cwd, setCwd] = useState("~"); // ~ represents project root
  const cursorPosRef = useRef(0);
  const isExecutingRef = useRef(false);

  // Terminal prompt
  const getPrompt = useCallback(() => {
    // Clean up cwd for display
    const displayCwd = cwd.replace(/\/+$/, "") || "~";
    return `\x1b[38;5;245m${displayCwd}\x1b[0m \x1b[38;5;208m❯\x1b[0m `;
  }, [cwd]);

  const writePrompt = useCallback(() => {
    if (xtermRef.current) {
      xtermRef.current.write("\r\n" + getPrompt());
    }
  }, [getPrompt]);

  const executeCommand = useCallback(
    async (command: string) => {
      const term = xtermRef.current;
      if (!term || isExecutingRef.current) return;

      const trimmedCommand = command.trim();
      if (!trimmedCommand) {
        writePrompt();
        return;
      }

      // Add to history
      setCommandHistory((prev) => {
        const newHistory = [...prev, trimmedCommand];
        return newHistory.slice(-100);
      });

      // Handle built-in client-side commands
      if (trimmedCommand === "clear" || trimmedCommand === "cls") {
        term.clear();
        term.write(getPrompt());
        return;
      }

      if (trimmedCommand === "help") {
        term.write("\r\n");
        term.write(
          "\x1b[38;5;245m╭────────────────────────────────────────────────────────────╮\x1b[0m\r\n",
        );
        term.write(
          "\x1b[38;5;245m│\x1b[0m  \x1b[1;38;5;208mEliza Cloud Sandbox Terminal\x1b[0m                            \x1b[38;5;245m│\x1b[0m\r\n",
        );
        term.write(
          "\x1b[38;5;245m├────────────────────────────────────────────────────────────┤\x1b[0m\r\n",
        );
        term.write(
          "\x1b[38;5;245m│\x1b[0m  \x1b[38;5;75mFile Commands:\x1b[0m                                           \x1b[38;5;245m│\x1b[0m\r\n",
        );
        term.write(
          "\x1b[38;5;245m│\x1b[0m    ls, cat, head, tail, find, grep, pwd, cd, mkdir        \x1b[38;5;245m│\x1b[0m\r\n",
        );
        term.write(
          "\x1b[38;5;245m│\x1b[0m                                                            \x1b[38;5;245m│\x1b[0m\r\n",
        );
        term.write(
          "\x1b[38;5;245m│\x1b[0m  \x1b[38;5;75mPackage Managers:\x1b[0m                                        \x1b[38;5;245m│\x1b[0m\r\n",
        );
        term.write(
          "\x1b[38;5;245m│\x1b[0m    npm, bun, pnpm, yarn, npx, bunx                         \x1b[38;5;245m│\x1b[0m\r\n",
        );
        term.write(
          "\x1b[38;5;245m│\x1b[0m                                                            \x1b[38;5;245m│\x1b[0m\r\n",
        );
        term.write(
          "\x1b[38;5;245m│\x1b[0m  \x1b[38;5;75mGit:\x1b[0m                                                     \x1b[38;5;245m│\x1b[0m\r\n",
        );
        term.write(
          "\x1b[38;5;245m│\x1b[0m    git status, git log, git diff, git branch, etc.        \x1b[38;5;245m│\x1b[0m\r\n",
        );
        term.write(
          "\x1b[38;5;245m│\x1b[0m                                                            \x1b[38;5;245m│\x1b[0m\r\n",
        );
        term.write(
          "\x1b[38;5;245m│\x1b[0m  \x1b[38;5;75mDev Tools:\x1b[0m                                               \x1b[38;5;245m│\x1b[0m\r\n",
        );
        term.write(
          "\x1b[38;5;245m│\x1b[0m    node, bun, tsc, curl                                    \x1b[38;5;245m│\x1b[0m\r\n",
        );
        term.write(
          "\x1b[38;5;245m│\x1b[0m                                                            \x1b[38;5;245m│\x1b[0m\r\n",
        );
        term.write(
          "\x1b[38;5;245m│\x1b[0m  \x1b[38;5;75mLocal:\x1b[0m  clear, help, history                             \x1b[38;5;245m│\x1b[0m\r\n",
        );
        term.write(
          "\x1b[38;5;245m╰────────────────────────────────────────────────────────────╯\x1b[0m\r\n",
        );
        term.write(
          "\r\n\x1b[38;5;245mUse ↑/↓ to navigate history • Tab for autocomplete\x1b[0m",
        );
        writePrompt();
        return;
      }

      if (trimmedCommand === "history") {
        term.write("\r\n");
        if (commandHistory.length === 0) {
          term.write("\x1b[38;5;245mNo commands in history\x1b[0m");
        } else {
          commandHistory.forEach((cmd, i) => {
            term.write(
              `\x1b[38;5;245m${String(i + 1).padStart(3, " ")}\x1b[0m  ${cmd}\r\n`,
            );
          });
        }
        writePrompt();
        return;
      }

      // Check if session is available
      if (!sessionId) {
        term.write("\r\n");
        term.write(
          "\x1b[38;5;196mNo active session.\x1b[0m Start a session to run commands.",
        );
        writePrompt();
        return;
      }

      // Execute command on sandbox via API
      isExecutingRef.current = true;
      term.write("\r\n");

      try {
        const response = await fetch(
          `/api/v1/app-builder/sessions/${sessionId}/terminal`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ command: trimmedCommand, cwd }),
          },
        );

        const data = await response.json();

        if (!response.ok) {
          if (data.blocked) {
            term.write(
              `\x1b[38;5;196mBlocked:\x1b[0m ${data.error || "Command not allowed"}`,
            );
          } else {
            term.write(
              `\x1b[38;5;196mError:\x1b[0m ${data.error || "Command failed"}`,
            );
          }
          writePrompt();
          isExecutingRef.current = false;
          return;
        }

        // Handle cd command to update cwd display
        if (trimmedCommand.startsWith("cd ") || trimmedCommand === "cd") {
          const newDir =
            trimmedCommand === "cd" ? "~" : trimmedCommand.slice(3).trim();
          if (data.exitCode === 0) {
            // Update cwd based on the cd command
            if (newDir === "~" || newDir === "") {
              setCwd("~");
            } else if (newDir === "..") {
              if (cwd === "~" || cwd === "") {
                setCwd("~"); // Can't go above project root
              } else {
                const parts = cwd
                  .replace(/^~\/?/, "")
                  .split("/")
                  .filter(Boolean);
                parts.pop();
                setCwd(parts.length > 0 ? "~/" + parts.join("/") : "~");
              }
            } else if (newDir.startsWith("/")) {
              setCwd(newDir);
            } else if (newDir.startsWith("~")) {
              setCwd(newDir);
            } else {
              // Relative path
              const base = cwd === "~" ? "" : cwd.replace(/^~\/?/, "");
              setCwd("~/" + (base ? base + "/" : "") + newDir);
            }
          }
        }

        // Display output
        if (data.stdout) {
          // Format output with proper line endings
          const lines = data.stdout.split("\n");
          for (const line of lines) {
            term.write(line + "\r\n");
          }
        }

        if (data.stderr) {
          const lines = data.stderr.split("\n");
          for (const line of lines) {
            if (line.trim()) {
              term.write(`\x1b[38;5;196m${line}\x1b[0m\r\n`);
            }
          }
        }

        // Show exit code if non-zero
        if (data.exitCode !== 0) {
          term.write(`\x1b[38;5;245mExit code: ${data.exitCode}\x1b[0m`);
        }
      } catch (error) {
        term.write(
          `\x1b[38;5;196mError:\x1b[0m ${error instanceof Error ? error.message : "Failed to execute command"}`,
        );
      }

      isExecutingRef.current = false;
      writePrompt();
    },
    [sessionId, cwd, commandHistory, writePrompt, getPrompt],
  );

  useEffect(() => {
    if (!terminalRef.current || xtermRef.current) return;

    // Initialize xterm.js
    const term = new XTerminal({
      theme: {
        background: "#0a0a0b",
        foreground: "#e4e4e7",
        cursor: "#FF5800",
        cursorAccent: "#0a0a0b",
        selectionBackground: "#FF580040",
        selectionForeground: "#ffffff",
        black: "#18181b",
        red: "#ef4444",
        green: "#22c55e",
        yellow: "#eab308",
        blue: "#3b82f6",
        magenta: "#a855f7",
        cyan: "#06b6d4",
        white: "#e4e4e7",
        brightBlack: "#52525b",
        brightRed: "#f87171",
        brightGreen: "#4ade80",
        brightYellow: "#facc15",
        brightBlue: "#60a5fa",
        brightMagenta: "#c084fc",
        brightCyan: "#22d3ee",
        brightWhite: "#fafafa",
      },
      fontFamily:
        "'SF Mono', 'JetBrains Mono', 'Fira Code', 'Cascadia Code', Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.4,
      cursorBlink: true,
      cursorStyle: "bar",
      allowTransparency: true,
      scrollback: 1000,
      // Enable text selection and copying
      allowProposedApi: true,
      rightClickSelectsWord: true,
    });

    // Copy selected text to clipboard on selection
    term.onSelectionChange(() => {
      const selection = term.getSelection();
      if (selection) {
        navigator.clipboard.writeText(selection).catch(() => {
          // Silently fail if clipboard access is denied
        });
      }
    });

    // Initialize addons
    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);

    // Mount terminal
    term.open(terminalRef.current);
    fitAddon.fit();

    // Store refs
    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    // Welcome message
    term.write(
      "\x1b[38;5;208m╭─────────────────────────────────────────╮\x1b[0m\r\n",
    );
    term.write(
      "\x1b[38;5;208m│\x1b[0m  \x1b[1mEliza Cloud Sandbox Terminal\x1b[0m          \x1b[38;5;208m│\x1b[0m\r\n",
    );
    term.write(
      "\x1b[38;5;208m│\x1b[0m  \x1b[38;5;245mConnected to live sandbox shell\x1b[0m        \x1b[38;5;208m│\x1b[0m\r\n",
    );
    term.write(
      "\x1b[38;5;208m│\x1b[0m  \x1b[38;5;245mType \x1b[38;5;75mhelp\x1b[38;5;245m for available commands\x1b[0m     \x1b[38;5;208m│\x1b[0m\r\n",
    );
    term.write(
      "\x1b[38;5;208m╰─────────────────────────────────────────╯\x1b[0m\r\n",
    );
    term.write("\r\n\x1b[38;5;245m~\x1b[0m \x1b[38;5;208m❯\x1b[0m ");

    // Handle resize
    const handleResize = () => {
      if (fitAddonRef.current) {
        try {
          fitAddonRef.current.fit();
        } catch {
          // Ignore fit errors during unmount
        }
      }
    };

    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(terminalRef.current);

    return () => {
      resizeObserver.disconnect();
      term.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  // Handle input
  useEffect(() => {
    const term = xtermRef.current;
    if (!term) return;

    let currentLineBuffer = "";
    let localHistoryIndex = -1;

    const handleData = (data: string) => {
      if (disabled || isExecutingRef.current) return;

      // Handle special keys
      if (data === "\r") {
        // Enter
        const command = currentLineBuffer;
        currentLineBuffer = "";
        localHistoryIndex = -1;
        cursorPosRef.current = 0;
        executeCommand(command);
      } else if (data === "\x7f") {
        // Backspace
        if (currentLineBuffer.length > 0 && cursorPosRef.current > 0) {
          const before = currentLineBuffer.slice(0, cursorPosRef.current - 1);
          const after = currentLineBuffer.slice(cursorPosRef.current);
          currentLineBuffer = before + after;
          cursorPosRef.current--;

          // Redraw line
          term.write("\x1b[2K\r" + getPrompt() + currentLineBuffer);
          const moveBack = currentLineBuffer.length - cursorPosRef.current;
          if (moveBack > 0) {
            term.write(`\x1b[${moveBack}D`);
          }
        }
      } else if (data === "\x1b[A") {
        // Up arrow - history
        if (commandHistory.length > 0) {
          if (localHistoryIndex < commandHistory.length - 1) {
            localHistoryIndex++;
            const historyCommand =
              commandHistory[commandHistory.length - 1 - localHistoryIndex];
            currentLineBuffer = historyCommand;
            cursorPosRef.current = historyCommand.length;
            term.write("\x1b[2K\r" + getPrompt() + historyCommand);
          }
        }
      } else if (data === "\x1b[B") {
        // Down arrow - history
        if (localHistoryIndex > 0) {
          localHistoryIndex--;
          const historyCommand =
            commandHistory[commandHistory.length - 1 - localHistoryIndex];
          currentLineBuffer = historyCommand;
          cursorPosRef.current = historyCommand.length;
          term.write("\x1b[2K\r" + getPrompt() + historyCommand);
        } else if (localHistoryIndex === 0) {
          localHistoryIndex = -1;
          currentLineBuffer = "";
          cursorPosRef.current = 0;
          term.write("\x1b[2K\r" + getPrompt());
        }
      } else if (data === "\x1b[D") {
        // Left arrow
        if (cursorPosRef.current > 0) {
          cursorPosRef.current--;
          term.write(data);
        }
      } else if (data === "\x1b[C") {
        // Right arrow
        if (cursorPosRef.current < currentLineBuffer.length) {
          cursorPosRef.current++;
          term.write(data);
        }
      } else if (data === "\x03") {
        // Ctrl+C - copy if selection exists, otherwise cancel
        const selection = term.getSelection();
        if (selection) {
          navigator.clipboard.writeText(selection).catch(() => {});
        } else {
          term.write("^C");
          currentLineBuffer = "";
          cursorPosRef.current = 0;
          localHistoryIndex = -1;
          term.write("\r\n" + getPrompt());
        }
      } else if (data === "\x16") {
        // Ctrl+V - paste from clipboard
        navigator.clipboard
          .readText()
          .then((text) => {
            if (text) {
              // Insert pasted text at cursor position
              const before = currentLineBuffer.slice(0, cursorPosRef.current);
              const after = currentLineBuffer.slice(cursorPosRef.current);
              currentLineBuffer = before + text + after;
              cursorPosRef.current += text.length;
              term.write("\x1b[2K\r" + getPrompt() + currentLineBuffer);
              const moveBack = currentLineBuffer.length - cursorPosRef.current;
              if (moveBack > 0) {
                term.write(`\x1b[${moveBack}D`);
              }
            }
          })
          .catch(() => {});
      } else if (data === "\x0c") {
        // Ctrl+L - clear
        term.clear();
        term.write(getPrompt() + currentLineBuffer);
      } else if (data === "\t") {
        // Tab - autocomplete common commands
        const commands = [
          "ls",
          "cat",
          "cd",
          "pwd",
          "git",
          "npm",
          "bun",
          "node",
          "clear",
          "help",
          "history",
          "mkdir",
          "touch",
          "find",
          "grep",
          "curl",
        ];
        const matches = commands.filter((cmd) =>
          cmd.startsWith(currentLineBuffer),
        );
        if (matches.length === 1) {
          currentLineBuffer = matches[0];
          cursorPosRef.current = currentLineBuffer.length;
          term.write("\x1b[2K\r" + getPrompt() + currentLineBuffer);
        } else if (matches.length > 1) {
          term.write("\r\n");
          term.write(matches.map((m) => `\x1b[38;5;75m${m}\x1b[0m`).join("  "));
          term.write("\r\n" + getPrompt() + currentLineBuffer);
        }
      } else if (data >= " " && data <= "~") {
        // Printable characters
        const before = currentLineBuffer.slice(0, cursorPosRef.current);
        const after = currentLineBuffer.slice(cursorPosRef.current);
        currentLineBuffer = before + data + after;
        cursorPosRef.current++;

        // Redraw line
        term.write("\x1b[2K\r" + getPrompt() + currentLineBuffer);
        const moveBack = currentLineBuffer.length - cursorPosRef.current;
        if (moveBack > 0) {
          term.write(`\x1b[${moveBack}D`);
        }
      }
    };

    const disposable = term.onData(handleData);
    return () => disposable.dispose();
  }, [disabled, commandHistory, executeCommand, getPrompt]);

  // Focus terminal on click
  const handleContainerClick = useCallback(() => {
    xtermRef.current?.focus();
  }, []);

  return (
    <div
      className={`relative h-full bg-[#0a0a0b] ${disabled ? "opacity-50 pointer-events-none" : ""} ${className}`}
      onClick={handleContainerClick}
    >
      {/* Terminal container */}
      <div ref={terminalRef} className="h-full w-full p-2" />

      {/* Disabled overlay */}
      {disabled && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/50">
          <p className="text-white/50 text-sm">
            Start a session to use the terminal
          </p>
        </div>
      )}
    </div>
  );
}
