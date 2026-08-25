/**
 * Behavioral coverage for the sandbox engine factory, platform notes, and
 * argv tokenization. Drives the real module: no engine mock, no daemon.
 * Missing-binary paths are asserted only when the host actually lacks docker
 * or Apple Container; present-binary paths observe inspect/list on names that
 * cannot exist.
 */

import { arch, platform } from "node:os";
import { describe, expect, it } from "vitest";
import {
  AppleContainerEngine,
  buildContainerExecArgs,
  createEngine,
  DockerEngine,
  detectBestEngine,
  getAllEngineInfo,
  getPlatformSetupNotes,
  type SandboxEngineType,
} from "./sandbox-engine.ts";

const MISSING_CONTAINER = "eliza-sandbox-engine-coverage-missing";
const MISSING_IMAGE = "eliza-sandbox-engine-coverage-missing:tag";
const UNIQUE_LIST_PREFIX = "eliza-sandbox-engine-coverage-prefix-no-match";

function expectExecArgs(command: string, expected: string[]): void {
  expect(
    buildContainerExecArgs({
      containerId: "sandbox-1",
      command,
    }),
  ).toEqual(["exec", "sandbox-1", ...expected]);
}

describe("buildContainerExecArgs", () => {
  it("tokenizes a single unquoted command", () => {
    expectExecArgs("pwd", ["pwd"]);
  });

  it("trims surrounding whitespace before tokenizing", () => {
    expectExecArgs("  ls  -la  ", ["ls", "-la"]);
  });

  it("splits on tabs as well as spaces", () => {
    expectExecArgs("echo\thello", ["echo", "hello"]);
  });

  it("preserves spaces inside single quotes, including empty quotes", () => {
    expectExecArgs("echo 'hello world'", ["echo", "hello world"]);
    expectExecArgs("echo ''", ["echo", ""]);
  });

  it("preserves spaces inside double quotes, including empty quotes", () => {
    expectExecArgs('echo "hello world"', ["echo", "hello world"]);
    expectExecArgs('echo ""', ["echo", ""]);
  });

  it("treats a quoted-empty command as one empty argument, not a missing command", () => {
    expectExecArgs("''", [""]);
    expectExecArgs('""', [""]);
  });

  it("keeps shell metacharacters literal inside single quotes", () => {
    expectExecArgs("echo 'a|$HOME;'", ["echo", "a|$HOME;"]);
  });

  it("keeps an unescaped dollar inside double quotes", () => {
    expectExecArgs('echo "foo$bar"', ["echo", "foo$bar"]);
  });

  it("unescapes double-quote, backslash, dollar, and backtick inside double quotes", () => {
    expectExecArgs(String.raw`echo "a\"b"`, ["echo", 'a"b']);
    expectExecArgs(String.raw`echo "a\\b"`, ["echo", "a\\b"]);
    expectExecArgs(String.raw`echo "a\$b"`, ["echo", "a$b"]);
    expectExecArgs(String.raw`echo "a\`b"`, ["echo", "a`b"]);
  });

  it("keeps a backslash inside double quotes when the next character is not special", () => {
    expectExecArgs(String.raw`echo "a\nb"`, ["echo", String.raw`a\nb`]);
  });

  it("does not emit -w when workdir is omitted or empty", () => {
    expect(
      buildContainerExecArgs({ containerId: "c1", command: "true" }),
    ).toEqual(["exec", "c1", "true"]);
    expect(
      buildContainerExecArgs({
        containerId: "c1",
        command: "true",
        workdir: "",
      }),
    ).toEqual(["exec", "c1", "true"]);
  });

  it("does not emit -e flags for an empty environment object", () => {
    expect(
      buildContainerExecArgs({
        containerId: "c1",
        command: "true",
        env: {},
      }),
    ).toEqual(["exec", "c1", "true"]);
  });

  it("rejects an empty or whitespace-only command", () => {
    expect(() =>
      buildContainerExecArgs({ containerId: "c1", command: "" }),
    ).toThrow("Container exec command is required");
    expect(() =>
      buildContainerExecArgs({ containerId: "c1", command: "   " }),
    ).toThrow("Container exec command is required");
  });

  it("rejects unterminated single and double quotes", () => {
    expect(() => expectExecArgs("echo 'hello", [])).toThrow(
      "Container exec command has unterminated quotes",
    );
    expect(() => expectExecArgs('echo "hello', [])).toThrow(
      "Container exec command has unterminated quotes",
    );
  });

  it("rejects a dangling backslash at the end of the command", () => {
    expect(() => expectExecArgs("echo \\", [])).toThrow(
      "Container exec command cannot end with dangling escape",
    );
  });

  it.each(["&", "|", ";", "<", ">", "$", "`", "(", ")", "{", "}"])(
    "rejects unquoted shell syntax %s",
    (char) => {
      expect(() => expectExecArgs(`echo ${char}x`, [])).toThrow(
        "Container exec command contains unsupported shell syntax",
      );
    },
  );

  it("treats embedded newlines and carriage returns as argument separators", () => {
    // /\s/ matches before the unsupported-syntax table, so \n and \r split
    // tokens instead of throwing even though they appear in that table.
    expectExecArgs("echo\nfoo", ["echo", "foo"]);
    expectExecArgs("echo\rfoo", ["echo", "foo"]);
  });
});

describe("createEngine", () => {
  it("returns DockerEngine for docker", () => {
    const engine = createEngine("docker");
    expect(engine).toBeInstanceOf(DockerEngine);
    expect(engine.engineType).toBe("docker");
  });

  it("returns AppleContainerEngine for apple-container", () => {
    const engine = createEngine("apple-container");
    expect(engine).toBeInstanceOf(AppleContainerEngine);
    expect(engine.engineType).toBe("apple-container");
  });

  it("returns the same engine class as detectBestEngine for auto", () => {
    const auto = createEngine("auto");
    const detected = detectBestEngine();
    expect(auto.constructor).toBe(detected.constructor);
    expect(auto.engineType).toBe(detected.engineType);
  });

  it("falls through to DockerEngine for an unknown type", () => {
    const engine = createEngine("not-an-engine" as SandboxEngineType);
    expect(engine).toBeInstanceOf(DockerEngine);
    expect(engine.engineType).toBe("docker");
  });
});

describe("detectBestEngine", () => {
  it("prefers Apple Container only on ARM Mac when that binary is available", () => {
    const detected = detectBestEngine();
    const apple = new AppleContainerEngine();
    if (platform() === "darwin" && arch() === "arm64" && apple.isAvailable()) {
      expect(detected).toBeInstanceOf(AppleContainerEngine);
      expect(detected.engineType).toBe("apple-container");
    } else {
      expect(detected).toBeInstanceOf(DockerEngine);
      expect(detected.engineType).toBe("docker");
    }
  });
});

describe("getAllEngineInfo", () => {
  it("reports docker then apple-container with the observed platform fields", () => {
    const infos = getAllEngineInfo();
    expect(infos).toHaveLength(2);

    const docker = infos[0];
    const apple = infos[1];
    expect(docker?.type).toBe("docker");
    expect(docker?.platform).toBe(platform());
    expect(docker?.arch).toBe(arch());
    expect(typeof docker?.available).toBe("boolean");
    expect(typeof docker?.version).toBe("string");
    expect(docker?.version.length).toBeGreaterThan(0);
    expect(typeof docker?.details).toBe("string");

    expect(apple?.type).toBe("apple-container");
    expect(apple?.platform).toBe("darwin");
    expect(apple?.arch).toBe(arch());
    expect(apple?.details).toBe(
      `Apple Silicon: ${arch() === "arm64" ? "yes" : "no"}`,
    );
    expect(typeof apple?.available).toBe("boolean");
    expect(typeof apple?.version).toBe("string");
    expect(apple?.version.length).toBeGreaterThan(0);
  });
});

describe("getPlatformSetupNotes", () => {
  it("returns the notes for the live host platform and architecture", () => {
    const notes = getPlatformSetupNotes();
    const os = platform();
    const cpu = arch();

    if (os === "darwin" && cpu === "arm64") {
      expect(notes).toContain("macOS Apple Silicon detected.");
      expect(notes).toContain(
        "Preferred: Apple Container (install via: brew install apple/apple/container-tools)",
      );
      expect(notes).toContain("Fallback: Docker Desktop for Mac");
    } else if (os === "darwin") {
      expect(notes).toContain("macOS Intel detected.");
      expect(notes).toContain("Use: Docker Desktop for Mac");
      expect(notes).toContain(
        "Apple Container is not available on Intel Macs.",
      );
    } else if (os === "linux") {
      expect(notes).toContain("Linux detected.");
      expect(notes).toContain("Use: Docker (install via your package manager)");
    } else if (os === "win32") {
      expect(notes).toContain("Windows detected.");
      expect(notes).toContain("Use: Docker Desktop with WSL2 backend");
    } else {
      expect(notes).toBe(
        `Unsupported platform: ${os}. Docker may work if installed.`,
      );
    }
  });
});

describe("DockerEngine", () => {
  const engine = new DockerEngine();

  it("identifies as docker and matches getInfo availability", () => {
    expect(engine.engineType).toBe("docker");
    const info = engine.getInfo();
    expect(info.type).toBe("docker");
    expect(info.available).toBe(engine.isAvailable());
    expect(info.platform).toBe(platform());
    expect(info.arch).toBe(arch());
    if (!info.available) {
      expect(info.version).toBe("unknown");
      expect(info.details).toBe("default");
    }
  });

  it("lists no containers for a prefix that cannot match, and reports missing ids unhealthy", async () => {
    expect(engine.listContainers(UNIQUE_LIST_PREFIX)).toEqual([]);
    expect(await engine.healthCheck(MISSING_CONTAINER)).toBe(false);
    expect(engine.isContainerRunning(MISSING_CONTAINER)).toBe(false);
    expect(engine.imageExists(MISSING_IMAGE)).toBe(false);
  });

  it("swallows stop and remove failures for a name the host does not own", async () => {
    // Teardown ownership guard (#25883): with a daemon installed these calls
    // issue real stop/rm CLI commands, so coverage must first prove the host
    // owns no such resource (ps -a also covers stopped containers). A
    // non-empty listing means a developer's live container carries this name
    // — skip the destructive assertions rather than touch it.
    if (engine.listContainers(MISSING_CONTAINER).length > 0) {
      return;
    }
    await expect(
      engine.stopContainer(MISSING_CONTAINER),
    ).resolves.toBeUndefined();
    await expect(
      engine.removeContainer(MISSING_CONTAINER),
    ).resolves.toBeUndefined();
  });

  it("throws from run, exec, and pull when docker is not on the host PATH", async () => {
    if (engine.isAvailable()) {
      return;
    }
    await expect(
      engine.runContainer({
        image: MISSING_IMAGE,
        name: MISSING_CONTAINER,
        detach: true,
        mounts: [],
        env: {},
        network: "",
        user: "",
        capDrop: [],
      }),
    ).rejects.toThrow("Docker executable unavailable");
    await expect(
      engine.execInContainer({
        containerId: MISSING_CONTAINER,
        command: "true",
      }),
    ).rejects.toThrow("Docker executable unavailable");
    await expect(engine.pullImage(MISSING_IMAGE)).rejects.toThrow(
      "Docker executable unavailable",
    );
  });
});

describe("AppleContainerEngine", () => {
  const engine = new AppleContainerEngine();

  it("identifies as apple-container and hard-codes platform darwin", () => {
    expect(engine.engineType).toBe("apple-container");
    const info = engine.getInfo();
    expect(info.type).toBe("apple-container");
    expect(info.available).toBe(engine.isAvailable());
    expect(info.platform).toBe("darwin");
    expect(info.arch).toBe(arch());
    expect(info.details).toBe(
      `Apple Silicon: ${arch() === "arm64" ? "yes" : "no"}`,
    );
    if (!info.available) {
      expect(info.version).toBe("unknown");
    }
  });

  it("lists no containers for a prefix that cannot match, and reports missing ids unhealthy", async () => {
    expect(engine.listContainers(UNIQUE_LIST_PREFIX)).toEqual([]);
    expect(await engine.healthCheck(MISSING_CONTAINER)).toBe(false);
    expect(engine.isContainerRunning(MISSING_CONTAINER)).toBe(false);
    expect(engine.imageExists(MISSING_IMAGE)).toBe(false);
  });

  it("swallows stop and remove failures for a name the host does not own", async () => {
    // Teardown ownership guard (#25883): with a daemon installed these calls
    // issue real stop/rm CLI commands, so coverage must first prove the host
    // owns no such resource. A non-empty listing means a live container
    // carries this name — skip the destructive assertions rather than touch it.
    if (engine.listContainers(MISSING_CONTAINER).length > 0) {
      return;
    }
    await expect(
      engine.stopContainer(MISSING_CONTAINER),
    ).resolves.toBeUndefined();
    await expect(
      engine.removeContainer(MISSING_CONTAINER),
    ).resolves.toBeUndefined();
  });

  it("throws from exec and pull when Apple Container is not on the host PATH", async () => {
    if (engine.isAvailable()) {
      return;
    }
    await expect(
      engine.execInContainer({
        containerId: MISSING_CONTAINER,
        command: "true",
      }),
    ).rejects.toThrow("Apple Container executable unavailable");
    await expect(engine.pullImage(MISSING_IMAGE)).rejects.toThrow(
      "Apple Container executable unavailable",
    );
  });
});
