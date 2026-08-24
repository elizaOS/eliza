/** Exercises MCP server helper routing with deterministic request and plugin fixtures. */

import { validateMcpServerConfig } from "@elizaos/core/security/mcp-server-config";
import { describe, expect, it } from "vitest";
import {
  mcpServersIncludeStdio,
  resolveMcpServersRejection,
  resolveMcpTerminalAuthorizationRejection,
} from "../../src/api/server-helpers-mcp.ts";

function stdioConfig(
  command: string,
  args: string[],
  env: Record<string, string>,
): Record<string, unknown> {
  return { type: "stdio", command, args, env };
}

describe("validateMcpServerConfig env hardening (GHSA-54rx-pcr9-hg9x)", () => {
  it("rejects classic exact-match blocked env keys", async () => {
    expect(
      await validateMcpServerConfig(
        stdioConfig("npx", ["pkg"], { LD_PRELOAD: "/tmp/evil.so" }),
      ),
    ).toMatch(/not allowed for security reasons/i);
    expect(
      await validateMcpServerConfig(
        stdioConfig("npx", ["pkg"], { PATH: "/tmp" }),
      ),
    ).toMatch(/not allowed for security reasons/i);
  });

  it("rejects blocked CLI flags on package runners", async () => {
    expect(
      await validateMcpServerConfig(
        stdioConfig(
          "npx",
          ["-c", "require('fs').readFileSync('/etc/passwd')"],
          {},
        ),
      ),
    ).toMatch(/not allowed for npx/i);
  });

  it("blocks package-runner registry and config-file argv channels", async () => {
    expect(
      await validateMcpServerConfig(
        stdioConfig(
          "uvx",
          ["--index-url", "http://127.0.0.1:9999/simple", "evil-pkg"],
          {},
        ),
      ),
    ).toMatch(/--index-url.*not allowed for uvx/i);

    expect(
      await validateMcpServerConfig(
        stdioConfig("uvx", ["--config-file", "/tmp/uv.toml", "evil-pkg"], {}),
      ),
    ).toMatch(/--config-file.*not allowed for uvx/i);

    expect(
      await validateMcpServerConfig(
        stdioConfig(
          "npx",
          ["--registry=http://127.0.0.1:9999/npm", "evil-pkg"],
          {},
        ),
      ),
    ).toMatch(/--registry.*not allowed for npx/i);
  });

  it("rejects blocked CLI flags on interpreters", async () => {
    expect(
      await validateMcpServerConfig(stdioConfig("node", ["--eval", "1"], {})),
    ).toMatch(/not allowed for node/i);
  });

  it("blocks npm env-channel install/registry bypass", async () => {
    const payload = stdioConfig("npx", ["evil-pkg"], {
      NPM_CONFIG_YES: "true",
      NPM_CONFIG_REGISTRY: "http://127.0.0.1:9999/evil-registry/",
      NPM_CONFIG_FETCH_RETRIES: "0",
    });
    expect(await validateMcpServerConfig(payload)).toMatch(
      /blocked prefix NPM_CONFIG_/i,
    );
  });

  it("blocks bunx registry redirect via npm-compat env", async () => {
    expect(
      await validateMcpServerConfig(
        stdioConfig("bunx", ["evil-pkg"], {
          NPM_CONFIG_REGISTRY: "http://attacker.example/npm",
        }),
      ),
    ).toMatch(/blocked prefix NPM_CONFIG_/i);
  });

  it("blocks uvx index and config env channels", async () => {
    expect(
      await validateMcpServerConfig(
        stdioConfig("uvx", ["evil-py-pkg"], {
          UV_INDEX_URL: "http://attacker.example/pypi",
          UV_DEFAULT_INDEX: "http://attacker.example/pypi",
        }),
      ),
    ).toMatch(/blocked prefix UV_/i);

    expect(
      await validateMcpServerConfig(
        stdioConfig("uvx", ["evil-py-pkg"], {
          UV_CONFIG_FILE: "/tmp/attacker-uv.toml",
        }),
      ),
    ).toMatch(/blocked prefix UV_/i);
  });

  it("blocks pip and pnpm env families", async () => {
    expect(
      await validateMcpServerConfig(
        stdioConfig("uv", ["tool", "run", "pkg"], {
          PIP_INDEX_URL: "http://attacker.example/pypi",
        }),
      ),
    ).toMatch(/blocked prefix PIP_/i);

    expect(
      await validateMcpServerConfig(
        stdioConfig("npx", ["pkg"], { PNPM_HOME: "/tmp" }),
      ),
    ).toMatch(/blocked prefix PNPM_/i);
  });

  it("blocks docker and podman client redirect env", async () => {
    expect(
      await validateMcpServerConfig(
        stdioConfig("docker", ["ps"], { DOCKER_HOST: "tcp://attacker:2375" }),
      ),
    ).toMatch(/blocked prefix DOCKER_/i);
  });

  it("rejects env values containing null bytes", async () => {
    expect(
      await validateMcpServerConfig(
        stdioConfig("npx", ["pkg"], { FOO: "safe\0evil" }),
      ),
    ).toMatch(/null byte/i);
  });

  it("allows benign stdio env without package-manager config channels", async () => {
    expect(
      await validateMcpServerConfig(
        stdioConfig("npx", ["@scope/pkg"], {
          LOG_LEVEL: "info",
          NO_COLOR: "1",
        }),
      ),
    ).toBeNull();
  });
});

describe("validateMcpServerConfig spawn-env-policy key coverage", () => {
  // Table-driven: every key that the spawn sanitizer blocks must also be
  // rejected by the MCP config validator, proving the security boundary holds
  // end-to-end (config → validateMcpServerConfig → spawn).
  const newInjectionKeys: Array<[string, string]> = [
    ["JDK_JAVA_OPTIONS", "-javaagent:/tmp/evil.jar"],
    ["GIT_SSH", "/tmp/evil-ssh"],
    ["GIT_ASKPASS", "/tmp/evil-askpass"],
    ["GIT_CONFIG_COUNT", "1"],
    ["GIT_CONFIG_KEY_0", "core.sshCommand"],
    ["GIT_CONFIG_VALUE_0", "/tmp/evil-cmd"],
    // Keys from the original PR that the reviewer confirmed are present
    ["JAVA_TOOL_OPTIONS", "-javaagent:/tmp/evil.jar"],
    ["_JAVA_OPTIONS", "-javaagent:/tmp/evil.jar"],
    ["GIT_SSH_COMMAND", "/tmp/evil-ssh-wrapper"],
    ["GIT_EXTERNAL_DIFF", "/tmp/evil-diff"],
    ["CLASSPATH", "/tmp/evil.jar"],
  ];

  it.each(newInjectionKeys)(
    "rejects %s through the config validator",
    async (key, value) => {
      const rejection = await validateMcpServerConfig(
        stdioConfig("npx", ["pkg"], { [key]: value }),
      );
      // Exact-match keys return "not allowed for security reasons";
      // prefix-matched keys return "matches blocked prefix ... and is not allowed".
      expect(rejection).toMatch(
        /not allowed for security reasons|matches blocked prefix/i,
      );
    },
  );

  it("rejects GIT_CONFIG_KEY_0 as a prefix-matched key", async () => {
    const rejection = await validateMcpServerConfig(
      stdioConfig("npx", ["pkg"], {
        GIT_CONFIG_KEY_0: "core.editor",
        GIT_CONFIG_VALUE_0: "/tmp/evil-editor",
      }),
    );
    expect(rejection).toMatch(/blocked prefix GIT_CONFIG_KEY_/i);
  });

  it("allows benign git env keys that are NOT on the denylist", async () => {
    expect(
      await validateMcpServerConfig(
        stdioConfig("npx", ["pkg"], {
          GIT_AUTHOR_NAME: "test",
          GIT_COMMITTER_NAME: "test",
          GIT_TERMINAL_PROMPT: "0",
        }),
      ),
    ).toBeNull();
  });
});

describe("validateMcpServerConfig container flag hardening", () => {
  it("blocks docker host-escape flags beyond the first positional arg", async () => {
    expect(
      await validateMcpServerConfig(
        stdioConfig(
          "docker",
          ["run", "--rm", "--device-cgroup-rule=c *:* rwm", "img"],
          {},
        ),
      ),
    ).toMatch(/--device-cgroup-rule.*not allowed/i);

    expect(
      await validateMcpServerConfig(
        stdioConfig("docker", ["run", "--volumes-from", "other", "img"], {}),
      ),
    ).toMatch(/--volumes-from.*not allowed/i);

    expect(
      await validateMcpServerConfig(
        stdioConfig("docker", ["run", "--net=host", "img"], {}),
      ),
    ).toMatch(/--net.*not allowed/i);

    expect(
      await validateMcpServerConfig(
        stdioConfig("podman", ["run", "--net", "host", "img"], {}),
      ),
    ).toMatch(/--net.*not allowed/i);
  });

  it("still blocks the pre-existing privileged/volume flags", async () => {
    expect(
      await validateMcpServerConfig(
        stdioConfig("podman", ["run", "--privileged", "img"], {}),
      ),
    ).toMatch(/--privileged.*not allowed/i);
    expect(
      await validateMcpServerConfig(
        stdioConfig("docker", ["run", "-v", "/:/host", "img"], {}),
      ),
    ).toMatch(/-v.*not allowed/i);
  });

  it("allows a benign docker run config", async () => {
    expect(
      await validateMcpServerConfig(
        stdioConfig("docker", ["run", "--rm", "-i", "my-mcp-image"], {}),
      ),
    ).toBeNull();
  });
});

describe("validateMcpServerConfig deno permission-escape hardening", () => {
  it("blocks deno allow-all / capability flags anywhere in the args", async () => {
    expect(
      await validateMcpServerConfig(
        stdioConfig("deno", ["run", "-A", "./server.ts"], {}),
      ),
    ).toMatch(/-A.*not allowed for deno/i);

    expect(
      await validateMcpServerConfig(
        stdioConfig("deno", ["run", "--allow-all", "./server.ts"], {}),
      ),
    ).toMatch(/--allow-all.*not allowed for deno/i);

    expect(
      await validateMcpServerConfig(
        stdioConfig("deno", ["run", "--allow-run=sh", "./server.ts"], {}),
      ),
    ).toMatch(/--allow-run.*not allowed for deno/i);

    expect(
      await validateMcpServerConfig(
        stdioConfig("deno", ["run", "--allow-scripts", "./server.ts"], {}),
      ),
    ).toMatch(/--allow-scripts.*not allowed for deno/i);
  });

  it("blocks deno permission short aliases", async () => {
    expect(
      await validateMcpServerConfig(
        stdioConfig("deno", ["run", "-N", "./server.ts"], {}),
      ),
    ).toMatch(/-N.*not allowed for deno/i);

    expect(
      await validateMcpServerConfig(
        stdioConfig("deno", ["run", "-R=/etc", "./server.ts"], {}),
      ),
    ).toMatch(/-R.*not allowed for deno/i);
  });

  it("blocks deno --unstable* flag family", async () => {
    expect(
      await validateMcpServerConfig(
        stdioConfig("deno", ["run", "--unstable-ffi", "./server.ts"], {}),
      ),
    ).toMatch(/--unstable.*not allowed for deno/i);
  });

  it("routes deno remote run scripts through the SSRF guard", async () => {
    expect(
      await validateMcpServerConfig(
        stdioConfig("deno", ["run", "http://127.0.0.1/evil.ts"], {}),
      ),
    ).toMatch(/blocked for security reasons|resolves to blocked/i);
    expect(
      await validateMcpServerConfig(
        stdioConfig("deno", ["run", "https://localhost/evil.ts"], {}),
      ),
    ).toMatch(/blocked for security reasons/i);
  });

  it("still blocks the deno eval subcommand", async () => {
    expect(
      await validateMcpServerConfig(
        stdioConfig("deno", ["eval", "console.log(1)"], {}),
      ),
    ).toMatch(/eval.*not allowed for deno/i);
  });

  it("allows a benign local deno run config", async () => {
    expect(
      await validateMcpServerConfig(
        stdioConfig("deno", ["run", "./mcp-server.ts"], {}),
      ),
    ).toBeNull();
  });
});

function withMcpAuthEnv(
  overrides: Record<string, string | undefined>,
  run: () => void,
): void {
  const names = Object.keys(overrides);
  const prior = names.map((name) => [name, process.env[name]] as const);
  try {
    for (const name of names) {
      const value = overrides[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    run();
  } finally {
    for (const [name, value] of prior) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

describe("mcpServersIncludeStdio classification edges", () => {
  it("returns false for an empty server map", () => {
    expect(mcpServersIncludeStdio({})).toBe(false);
  });

  it("ignores remote-only maps", () => {
    expect(
      mcpServersIncludeStdio({
        remote: { type: "http", url: "https://example.com/mcp" },
      }),
    ).toBe(false);
  });

  it("skips non-object entries instead of throwing", () => {
    expect(
      mcpServersIncludeStdio({
        broken: null,
        label: "stdio",
        list: [{ type: "stdio" }],
      }),
    ).toBe(false);
  });

  it("matches the stdio type string exactly", () => {
    expect(
      mcpServersIncludeStdio({ local: { type: "STDIO", command: "npx" } }),
    ).toBe(false);
  });
});

describe("resolveMcpServersRejection", () => {
  it("accepts an empty server map", async () => {
    expect(await resolveMcpServersRejection({})).toBeNull();
  });

  it("accepts a benign stdio server config", async () => {
    expect(
      await resolveMcpServersRejection({
        files: stdioConfig("npx", ["@scope/pkg"], { LOG_LEVEL: "info" }),
      }),
    ).toBeNull();
  });

  it("rejects blocked server names before inspecting the config shape", async () => {
    expect(await resolveMcpServersRejection({ ["__proto__"]: null })).toBe(
      'Invalid server name: "__proto__"',
    );
    expect(await resolveMcpServersRejection({ $include: "x" })).toBe(
      'Invalid server name: "$include"',
    );
  });

  it("requires each server config to be a JSON object", async () => {
    expect(await resolveMcpServersRejection({ broken: null })).toBe(
      'Server "broken" config must be a JSON object',
    );
    expect(
      await resolveMcpServersRejection({
        broken: [stdioConfig("npx", ["p"], {})],
      }),
    ).toBe('Server "broken" config must be a JSON object');
    expect(await resolveMcpServersRejection({ broken: "npx pkg" })).toBe(
      'Server "broken" config must be a JSON object',
    );
  });

  it("rejects blocked object keys nested inside a server config", async () => {
    expect(
      await resolveMcpServersRejection({
        files: {
          ...stdioConfig("npx", ["@scope/pkg"], {}),
          env: { LOG_LEVEL: "info", $include: "/etc/passwd" },
        },
      }),
    ).toBe('Server "files" contains blocked object keys');
    expect(
      await resolveMcpServersRejection({
        files: {
          ...stdioConfig("npx", ["@scope/pkg"], {}),
          options: { transport: { constructor: "Function" } },
        },
      }),
    ).toBe('Server "files" contains blocked object keys');
  });

  it("wraps validator rejections with the offending server name", async () => {
    const rejection = await resolveMcpServersRejection({
      evil: stdioConfig("npx", ["pkg"], { LD_PRELOAD: "/tmp/evil.so" }),
    });
    expect(rejection).toMatch(/^Server "evil": /);
    expect(rejection).toMatch(/not allowed/i);
  });

  it("reports the first failing server in declaration order", async () => {
    expect(
      await resolveMcpServersRejection({
        alpha: stdioConfig("npx", ["@scope/pkg"], {}),
        beta: [],
        gamma: null,
      }),
    ).toBe('Server "beta" config must be a JSON object');
  });

  it("keeps validating servers after earlier valid ones", async () => {
    expect(
      await resolveMcpServersRejection({
        ok: stdioConfig("npx", ["@scope/pkg"], {}),
        late: stdioConfig("deno", ["run", "-A", "./server.ts"], {}),
      }),
    ).toMatch(/^Server "late": /);
  });
});

describe("resolveMcpTerminalAuthorizationRejection stdio token enforcement", () => {
  it("skips authorization entirely for non-stdio server maps", () => {
    withMcpAuthEnv({ ELIZA_TERMINAL_RUN_TOKEN: "tok-1234" }, () => {
      expect(
        resolveMcpTerminalAuthorizationRejection(
          { headers: {} },
          { remote: { type: "http", url: "https://example.com/mcp" } },
          { terminalToken: "wrong" },
        ),
      ).toBeNull();
    });
  });

  it("accepts a matching X-Eliza-Terminal-Token header", () => {
    withMcpAuthEnv(
      {
        ELIZA_API_TOKEN: undefined,
        ELIZA_ALLOW_UNAUTHENTICATED_STDIO_MCP: undefined,
        ELIZA_TERMINAL_RUN_TOKEN: "tok-1234",
      },
      () => {
        expect(
          resolveMcpTerminalAuthorizationRejection(
            { headers: { "x-eliza-terminal-token": "tok-1234" } },
            { local: { type: "stdio", command: "npx", args: ["pkg"] } },
            {},
          ),
        ).toBeNull();
      },
    );
  });

  it("accepts a matching terminalToken in the request body", () => {
    withMcpAuthEnv(
      {
        ELIZA_API_TOKEN: undefined,
        ELIZA_ALLOW_UNAUTHENTICATED_STDIO_MCP: undefined,
        ELIZA_TERMINAL_RUN_TOKEN: "tok-1234",
      },
      () => {
        expect(
          resolveMcpTerminalAuthorizationRejection(
            { headers: {} },
            { local: { type: "stdio", command: "npx", args: ["pkg"] } },
            { terminalToken: "tok-1234" },
          ),
        ).toBeNull();
      },
    );
  });

  it("rejects a mismatched terminal token with 401", () => {
    withMcpAuthEnv(
      {
        ELIZA_API_TOKEN: undefined,
        ELIZA_ALLOW_UNAUTHENTICATED_STDIO_MCP: undefined,
        ELIZA_TERMINAL_RUN_TOKEN: "tok-1234",
      },
      () => {
        const rejection = resolveMcpTerminalAuthorizationRejection(
          { headers: {} },
          { local: { type: "stdio", command: "npx", args: ["pkg"] } },
          { terminalToken: "nope" },
        );
        expect(rejection?.status).toBe(401);
        expect(rejection?.reason).toMatch(/invalid terminal token/i);
      },
    );
  });

  it("rejects a stdio request carrying no terminal token with 401", () => {
    withMcpAuthEnv(
      {
        ELIZA_API_TOKEN: undefined,
        ELIZA_ALLOW_UNAUTHENTICATED_STDIO_MCP: undefined,
        ELIZA_TERMINAL_RUN_TOKEN: "tok-1234",
      },
      () => {
        const rejection = resolveMcpTerminalAuthorizationRejection(
          { headers: {} },
          { local: { type: "stdio", command: "npx", args: ["pkg"] } },
          {},
        );
        expect(rejection?.status).toBe(401);
        expect(rejection?.reason).toMatch(/missing terminal token/i);
      },
    );
  });

  it("keeps the API-token lockdown inside the legacy compat passthrough", () => {
    withMcpAuthEnv(
      {
        ELIZA_ALLOW_UNAUTHENTICATED_STDIO_MCP: "1",
        ELIZA_API_TOKEN: "api-tok",
        ELIZA_TERMINAL_RUN_TOKEN: undefined,
      },
      () => {
        const rejection = resolveMcpTerminalAuthorizationRejection(
          { headers: {} },
          { local: { type: "stdio", command: "npx", args: ["pkg"] } },
          {},
        );
        expect(rejection?.status).toBe(403);
        expect(rejection?.reason).toMatch(
          /terminal run is disabled for token-authenticated/i,
        );
      },
    );
  });
});
