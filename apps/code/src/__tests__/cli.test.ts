import { describe, expect, test } from "vitest";
import { parseArgs } from "../cli.js";

// ============================================================================
// Argument Parsing Tests
// ============================================================================

describe("parseArgs", () => {
  describe("flags", () => {
    test("should parse --help flag", () => {
      const result = parseArgs(["--help"]);
      expect(result.help).toBe(true);
    });

    test("should parse -h flag", () => {
      const result = parseArgs(["-h"]);
      expect(result.help).toBe(true);
    });

    test("should parse --version flag", () => {
      const result = parseArgs(["--version"]);
      expect(result.version).toBe(true);
    });

    test("should parse -v flag", () => {
      const result = parseArgs(["-v"]);
      expect(result.version).toBe(true);
    });

    test("should parse --json flag", () => {
      const result = parseArgs(["--json"]);
      expect(result.json).toBe(true);
    });

    test("should parse -j flag", () => {
      const result = parseArgs(["-j"]);
      expect(result.json).toBe(true);
    });

    test("should parse --stream flag", () => {
      const result = parseArgs(["--stream"]);
      expect(result.stream).toBe(true);
    });

    test("should parse -s flag", () => {
      const result = parseArgs(["-s"]);
      expect(result.stream).toBe(true);
    });

    test("should parse --interactive flag", () => {
      const result = parseArgs(["--interactive"]);
      expect(result.interactive).toBe(true);
    });

    test("should parse -i flag", () => {
      const result = parseArgs(["-i"]);
      expect(result.interactive).toBe(true);
    });
  });

  describe("options with values", () => {
    test("should parse --file option", () => {
      const result = parseArgs(["--file", "input.txt"]);
      expect(result.file).toBe("input.txt");
    });

    test("should parse -f option", () => {
      const result = parseArgs(["-f", "input.txt"]);
      expect(result.file).toBe("input.txt");
    });

    test("should parse --cwd option", () => {
      const result = parseArgs(["--cwd", "/some/path"]);
      expect(result.cwd).toBe("/some/path");
    });

    test("should parse -c option", () => {
      const result = parseArgs(["-c", "/some/path"]);
      expect(result.cwd).toBe("/some/path");
    });

    test("should throw for --file without value", () => {
      expect(() => parseArgs(["--file"])).toThrow(
        "--file requires a path argument",
      );
    });

    test("should throw for --cwd without value", () => {
      expect(() => parseArgs(["--cwd"])).toThrow(
        "--cwd requires a path argument",
      );
    });
  });

  describe("positional arguments", () => {
    test("should parse single word message", () => {
      const result = parseArgs(["hello"]);
      expect(result.message).toBe("hello");
    });

    test("should join multiple words as message", () => {
      const result = parseArgs(["hello", "world", "test"]);
      expect(result.message).toBe("hello world test");
    });

    test("should handle quoted message", () => {
      const result = parseArgs(["What files are in the directory?"]);
      expect(result.message).toBe("What files are in the directory?");
    });

    test("should return null for no positional args", () => {
      const result = parseArgs([]);
      expect(result.message).toBeNull();
    });
  });

  describe("combined options", () => {
    test("should parse multiple flags", () => {
      const result = parseArgs(["--json", "--stream"]);
      expect(result.json).toBe(true);
      expect(result.stream).toBe(true);
    });

    test("should parse flags with message", () => {
      const result = parseArgs(["--json", "What is the weather?"]);
      expect(result.json).toBe(true);
      expect(result.message).toBe("What is the weather?");
    });

    test("should parse all options together", () => {
      const result = parseArgs(["-j", "-c", "/test/path", "Review this code"]);
      expect(result.json).toBe(true);
      expect(result.cwd).toBe("/test/path");
      expect(result.message).toBe("Review this code");
    });

    test("should handle options before and after message", () => {
      const result = parseArgs(["-j", "Hello", "-c", "/path"]);
      // Options after positional args should still work
      expect(result.json).toBe(true);
      expect(result.cwd).toBe("/path");
      expect(result.message).toBe("Hello");
    });
  });

  describe("error handling", () => {
    test("should throw for unknown option", () => {
      expect(() => parseArgs(["--unknown"])).toThrow(
        "Unknown option: --unknown",
      );
    });

    test("should throw for unknown short option", () => {
      expect(() => parseArgs(["-x"])).toThrow("Unknown option: -x");
    });
  });

  describe("default values", () => {
    test("should have all defaults set correctly", () => {
      const result = parseArgs([]);

      expect(result.help).toBe(false);
      expect(result.version).toBe(false);
      expect(result.json).toBe(false);
      expect(result.stream).toBe(false);
      expect(result.file).toBeNull();
      expect(result.cwd).toBeNull();
      expect(result.message).toBeNull();
      expect(result.interactive).toBe(false);
    });
  });
});

// ============================================================================
// CLI Result Format Tests
// ============================================================================

describe("CLI result format", () => {
  test("should structure success result correctly", () => {
    interface CLIResult {
      success: boolean;
      response?: string;
      error?: string;
      timing?: {
        startedAt: number;
        completedAt: number;
        durationMs: number;
      };
    }

    const result: CLIResult = {
      success: true,
      response: "Test response",
      timing: {
        startedAt: 1000,
        completedAt: 2000,
        durationMs: 1000,
      },
    };

    expect(result.success).toBe(true);
    expect(result.response).toBe("Test response");
    expect(result.timing?.durationMs).toBe(1000);
  });

  test("should structure error result correctly", () => {
    interface CLIResult {
      success: boolean;
      response?: string;
      error?: string;
    }

    const result: CLIResult = {
      success: false,
      error: "Something went wrong",
    };

    expect(result.success).toBe(false);
    expect(result.error).toBe("Something went wrong");
    expect(result.response).toBeUndefined();
  });
});

// ============================================================================
// Edge Cases
// ============================================================================

describe("edge cases", () => {
  test("should handle empty string message", () => {
    const result = parseArgs([""]);
    expect(result.message).toBe("");
  });

  test("should handle message with special characters", () => {
    const result = parseArgs(['What\'s the "best" approach?']);
    expect(result.message).toBe('What\'s the "best" approach?');
  });

  test("should handle message with newlines", () => {
    const result = parseArgs(["Line 1\nLine 2"]);
    expect(result.message).toBe("Line 1\nLine 2");
  });

  test("should handle very long message", () => {
    const longMessage = "a".repeat(10000);
    const result = parseArgs([longMessage]);
    expect(result.message).toBe(longMessage);
  });

  test("should handle path with spaces", () => {
    const result = parseArgs(["-c", "/path/with spaces/here"]);
    expect(result.cwd).toBe("/path/with spaces/here");
  });
});
