import { describe, expect, it } from "vitest";
import { validateMcpServerConfig } from "../../src/api/server-helpers-mcp.ts";

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
