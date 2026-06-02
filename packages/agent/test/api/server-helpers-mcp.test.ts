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
