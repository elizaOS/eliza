/**
 * Direct unit coverage for the CLI startup banner. Drives the real module:
 * `formatCliBannerLine` is asserted against observed title, commit, and
 * rich/plain branches, and `emitCliBanner` is isolated per case so the
 * process-level one-shot guard, TTY gate, and `--json`/`--version` skips
 * can be observed without replacing the formatter.
 */
import { isRich, theme } from "@elizaos/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatCliBannerLine, hasEmittedCliBanner } from "./banner";
import { resolveCommitHash } from "./git-commit";

const stdout = process.stdout as NodeJS.WriteStream & { isTTY?: boolean };

function setStdoutTty(value: boolean | undefined): boolean | undefined {
  const previous = stdout.isTTY;
  stdout.isTTY = value;
  return previous;
}

async function loadBanner() {
  vi.resetModules();
  return import("./banner");
}

function captureStdoutWrite(): {
  chunks: string[];
  restore: () => void;
} {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation(((
    chunk: string | Uint8Array,
  ) => {
    chunks.push(
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(),
    );
    return true;
  }) as typeof process.stdout.write);
  return {
    chunks,
    restore: () => {
      spy.mockRestore();
    },
  };
}

describe("formatCliBannerLine", () => {
  it("defaults the title to Eliza and uses the plain layout when not rich", () => {
    expect(
      formatCliBannerLine("2.0.3", { commit: "abc1234", richTty: false }),
    ).toBe("Eliza 2.0.3 (abc1234)");
  });

  it("capitalizes only the first character of APP_CLI_NAME from options.env", () => {
    expect(
      formatCliBannerLine("1.0.0", {
        env: { APP_CLI_NAME: "elizaOS" },
        commit: "deadbee",
        richTty: false,
      }),
    ).toBe("ElizaOS 1.0.0 (deadbee)");
    expect(
      formatCliBannerLine("1.0.0", {
        env: { APP_CLI_NAME: "ELIZA" },
        commit: "deadbee",
        richTty: false,
      }),
    ).toBe("ELIZA 1.0.0 (deadbee)");
    expect(
      formatCliBannerLine("1.0.0", {
        env: { APP_CLI_NAME: "e" },
        commit: "deadbee",
        richTty: false,
      }),
    ).toBe("E 1.0.0 (deadbee)");
  });

  it("treats an empty APP_CLI_NAME as an empty title rather than the default", () => {
    expect(
      formatCliBannerLine("1.0.0", {
        env: { APP_CLI_NAME: "" },
        commit: "deadbee",
        richTty: false,
      }),
    ).toBe(" 1.0.0 (deadbee)");
  });

  it("does not read ambient process.env.APP_CLI_NAME for the title", () => {
    const previous = process.env.APP_CLI_NAME;
    process.env.APP_CLI_NAME = "ambientcli";
    try {
      expect(
        formatCliBannerLine("1.0.0", { commit: "xyz0000", richTty: false }),
      ).toBe("Eliza 1.0.0 (xyz0000)");
    } finally {
      if (previous === undefined) {
        delete process.env.APP_CLI_NAME;
      } else {
        process.env.APP_CLI_NAME = previous;
      }
    }
  });

  it("keeps an explicit commit string as-is, including empty and long values", () => {
    expect(
      formatCliBannerLine("1.2.3", {
        commit: "abcdefghijklmnop",
        richTty: false,
      }),
    ).toBe("Eliza 1.2.3 (abcdefghijklmnop)");
    expect(formatCliBannerLine("1.2.3", { commit: "", richTty: false })).toBe(
      "Eliza 1.2.3 ()",
    );
  });

  it("falls back to resolveCommitHash, then unknown, when commit is omitted or null", () => {
    const resolved = resolveCommitHash() ?? "unknown";
    expect(formatCliBannerLine("9.9.9", { richTty: false })).toBe(
      `Eliza 9.9.9 (${resolved})`,
    );
    expect(formatCliBannerLine("9.9.9", { richTty: false, commit: null })).toBe(
      `Eliza 9.9.9 (${resolved})`,
    );
  });

  it("themes title, version, and commit when richTty is true", () => {
    expect(
      formatCliBannerLine("2.0.3", { commit: "abc1234", richTty: true }),
    ).toBe(
      `${theme.heading("Eliza")} ${theme.info("2.0.3")} ${theme.muted("(abc1234)")}`,
    );
  });

  it("uses isRich() when richTty is omitted", () => {
    const line = formatCliBannerLine("1.0.0", { commit: "deadbee" });
    if (isRich()) {
      expect(line).toBe(
        `${theme.heading("Eliza")} ${theme.info("1.0.0")} ${theme.muted("(deadbee)")}`,
      );
    } else {
      expect(line).toBe("Eliza 1.0.0 (deadbee)");
    }
  });

  it("preserves an empty version between title and commit", () => {
    expect(formatCliBannerLine("", { commit: "abc1234", richTty: false })).toBe(
      "Eliza  (abc1234)",
    );
  });
});

describe("hasEmittedCliBanner", () => {
  it("starts false on a fresh module instance", () => {
    expect(hasEmittedCliBanner()).toBe(false);
  });
});

describe("emitCliBanner", () => {
  const originalIsTty = stdout.isTTY;
  const originalArgv = process.argv;

  afterEach(() => {
    stdout.isTTY = originalIsTty;
    process.argv = originalArgv;
  });

  it("stays silent and unemitted when stdout is not a TTY", async () => {
    const banner = await loadBanner();
    const capture = captureStdoutWrite();
    try {
      setStdoutTty(false);
      banner.emitCliBanner("2.0.3", {
        argv: ["node", "eliza", "start"],
        commit: "abc1234",
        richTty: false,
      });
      expect(capture.chunks).toEqual([]);
      expect(banner.hasEmittedCliBanner()).toBe(false);
    } finally {
      capture.restore();
    }
  });

  it.each(["--json", "--json=pretty", "--version", "-V", "-v"])(
    "stays silent on a TTY when argv contains %s",
    async (flag) => {
      const banner = await loadBanner();
      const capture = captureStdoutWrite();
      try {
        setStdoutTty(true);
        banner.emitCliBanner("2.0.3", {
          argv: ["node", "eliza", "start", flag],
          commit: "abc1234",
          richTty: false,
        });
        expect(capture.chunks).toEqual([]);
        expect(banner.hasEmittedCliBanner()).toBe(false);
      } finally {
        capture.restore();
      }
    },
  );

  it("does not treat --jsonish or --verbose as skip flags", async () => {
    const banner = await loadBanner();
    const capture = captureStdoutWrite();
    try {
      setStdoutTty(true);
      banner.emitCliBanner("2.0.3", {
        argv: ["node", "eliza", "--jsonish", "--verbose"],
        commit: "abc1234",
        richTty: false,
      });
      expect(capture.chunks).toEqual(["Eliza 2.0.3 (abc1234)\n\n"]);
      expect(banner.hasEmittedCliBanner()).toBe(true);
    } finally {
      capture.restore();
    }
  });

  it("writes the formatted line followed by two newlines on a TTY", async () => {
    const banner = await loadBanner();
    const capture = captureStdoutWrite();
    try {
      setStdoutTty(true);
      banner.emitCliBanner("2.0.3", {
        argv: ["node", "eliza", "start"],
        env: { APP_CLI_NAME: "elizaOS" },
        commit: "abc1234",
        richTty: false,
      });
      expect(capture.chunks).toEqual(["ElizaOS 2.0.3 (abc1234)\n\n"]);
      expect(banner.hasEmittedCliBanner()).toBe(true);
    } finally {
      capture.restore();
    }
  });

  it("emits an empty argv on a TTY because no skip flag is present", async () => {
    const banner = await loadBanner();
    const capture = captureStdoutWrite();
    try {
      setStdoutTty(true);
      banner.emitCliBanner("1.0.0", {
        argv: [],
        commit: "deadbee",
        richTty: false,
      });
      expect(capture.chunks).toEqual(["Eliza 1.0.0 (deadbee)\n\n"]);
    } finally {
      capture.restore();
    }
  });

  it("reads process.argv when options.argv is omitted", async () => {
    const banner = await loadBanner();
    const capture = captureStdoutWrite();
    try {
      setStdoutTty(true);
      process.argv = ["node", "eliza", "--json"];
      banner.emitCliBanner("1.0.0", { commit: "deadbee", richTty: false });
      expect(capture.chunks).toEqual([]);
      process.argv = ["node", "eliza", "start"];
      banner.emitCliBanner("1.0.0", { commit: "deadbee", richTty: false });
      expect(capture.chunks).toEqual(["Eliza 1.0.0 (deadbee)\n\n"]);
    } finally {
      capture.restore();
    }
  });

  it("does not latch the one-shot guard on a silent path, then emits once", async () => {
    const banner = await loadBanner();
    const capture = captureStdoutWrite();
    try {
      setStdoutTty(false);
      banner.emitCliBanner("1.0.0", {
        argv: ["node", "eliza", "start"],
        commit: "deadbee",
        richTty: false,
      });
      expect(banner.hasEmittedCliBanner()).toBe(false);

      setStdoutTty(true);
      banner.emitCliBanner("1.0.0", {
        argv: ["node", "eliza", "start"],
        commit: "deadbee",
        richTty: false,
      });
      banner.emitCliBanner("9.9.9", {
        argv: ["node", "eliza", "start"],
        commit: "fffffff",
        richTty: false,
      });
      expect(capture.chunks).toEqual(["Eliza 1.0.0 (deadbee)\n\n"]);
      expect(banner.hasEmittedCliBanner()).toBe(true);
    } finally {
      capture.restore();
    }
  });
});
