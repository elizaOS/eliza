/**
 * Pins DockerSandboxProvider's secret-bearing SSH transports. The harness
 * captures commands/stdin and executes safe remote parsers locally; it never
 * reaches a real Docker node or Steward deployment.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildRegisterAgentWithStewardRequest,
  buildSignedDeleteAgentRequest,
  buildStewardRefreshLoopScript,
  deregisterAgentWithSteward,
  registerAgentWithSteward,
  startStewardRefreshSidecar,
  writeManagedElizaRuntimeConfig,
} from "../docker-sandbox-provider";
import type { DockerSSHClient } from "../docker-ssh";

const PLATFORM_KEY_SENTINEL = "platform-key-sentinel-23804";
const SIGNING_SECRET_SENTINEL = "signing-secret-sentinel-23804";
const TENANT_KEY_SENTINEL = "tenant-key-sentinel-23804";
const CLOUD_API_KEY_SENTINEL = "cloud-api-key-sentinel-23804";
const REFRESH_SERVICE_TOKEN_SENTINEL = "refresh-service-token-sentinel-23804";
const RUN_REAL_DOCKER = process.env.ELIZA_DOCKER_ENV_STDIN_REAL === "1";
const MANAGED_ENV_KEYS = [
  "STEWARD_API_URL",
  "STEWARD_PLATFORM_KEY",
  "STEWARD_PLATFORM_KEYS",
  "STEWARD_REQUEST_SIGNING_SECRET",
  "STEWARD_REQUEST_SIGNING_SECRETS",
] as const;
const savedEnv = Object.fromEntries(MANAGED_ENV_KEYS.map((key) => [key, process.env[key]]));

interface CommandResult {
  code: number | null;
  stderr: string;
  stdout: string;
}

function restoreEnv(): void {
  for (const key of MANAGED_ENV_KEYS) {
    const saved = savedEnv[key];
    if (saved === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved;
    }
  }
}

function configureStewardSecrets(baseUrl = "https://steward.invalid.example"): void {
  process.env.STEWARD_API_URL = baseUrl;
  process.env.STEWARD_PLATFORM_KEY = PLATFORM_KEY_SENTINEL;
  delete process.env.STEWARD_PLATFORM_KEYS;
  process.env.STEWARD_REQUEST_SIGNING_SECRET = SIGNING_SECRET_SENTINEL;
  delete process.env.STEWARD_REQUEST_SIGNING_SECRETS;
}

function decodeJsonFrame(input: string): {
  end: string;
  header: string;
  payload: Record<string, unknown>;
} {
  const parts = input.split("\n");
  expect(parts).toHaveLength(4);
  expect(parts[3]).toBe("");
  return {
    header: parts[0],
    payload: JSON.parse(Buffer.from(parts[1], "base64").toString("utf8")) as Record<
      string,
      unknown
    >,
    end: parts[2],
  };
}

function runRemoteCommand(command: string, input: string | Buffer): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", command], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stderr, stdout }));
    child.stdin.end(input);
  });
}

function executingSsh(): DockerSSHClient {
  return {
    execStdin: async (command: string, input: string | Buffer) => {
      const result = await runRemoteCommand(command, input);
      if (result.code !== 0) {
        throw new Error(`${result.stderr}${result.stdout}`.trim());
      }
      return result.stdout;
    },
  } as unknown as DockerSSHClient;
}

async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ close: () => Promise<void>; url: string }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("test HTTP server did not expose a TCP address");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function finishRequest(request: IncomingMessage, callback: () => void): void {
  request.resume();
  request.once("end", callback);
}

function expectCommandHasNoAuthMaterial(
  command: string,
  headerSets: Array<Record<string, string>>,
): void {
  expect(command).not.toContain("X-Steward-Platform-Key");
  expect(command).not.toContain("x-steward-signature");
  for (const secret of [PLATFORM_KEY_SENTINEL, SIGNING_SECRET_SENTINEL, TENANT_KEY_SENTINEL]) {
    expect(command).not.toContain(secret);
    expect(command).not.toContain(Buffer.from(secret).toString("base64"));
  }
  for (const headers of headerSets) {
    for (const [name, value] of Object.entries(headers)) {
      if (name.toLowerCase().startsWith("x-steward-") && value) {
        expect(command).not.toContain(value);
      }
    }
  }
}

afterEach(() => {
  restoreEnv();
  mock.restore();
});

describe("DockerSandboxProvider Steward stdin transport (#23804)", () => {
  test("registers with platform and signed headers only in versioned stdin", async () => {
    configureStewardSecrets();
    let capturedCommand = "";
    let capturedInput = "";
    const execStdin = mock(async (command: string, input: string | Buffer) => {
      capturedCommand = command;
      capturedInput = String(input);
      return JSON.stringify({ token: "registered-agent-token" });
    });
    const ssh = { execStdin } as unknown as DockerSSHClient;

    const token = await registerAgentWithSteward(
      ssh,
      "agent-23804",
      "Secret transport sentinel",
      "tenant-23804",
      TENANT_KEY_SENTINEL,
    );

    expect(token).toBe("registered-agent-token");
    expect(execStdin).toHaveBeenCalledTimes(1);
    const frame = decodeJsonFrame(capturedInput);
    expect(frame.header).toBe("ELIZA_STEWARD_SSH_STDIN_V1:steward-agent-register");
    expect(frame.end).toBe("ELIZA_STEWARD_SSH_STDIN_END");
    const agentHeaders = frame.payload.agentHeaders as Record<string, string>;
    const tokenHeaders = frame.payload.tokenHeaders as Record<string, string>;
    expect(agentHeaders["X-Steward-Platform-Key"]).toBe(PLATFORM_KEY_SENTINEL);
    expect(tokenHeaders["X-Steward-Platform-Key"]).toBe(PLATFORM_KEY_SENTINEL);
    expect(agentHeaders["x-steward-signature"]).toStartWith("v1=");
    expect(tokenHeaders["x-steward-signature"]).toStartWith("v1=");
    expectCommandHasNoAuthMaterial(capturedCommand, [agentHeaders, tokenHeaders]);
  });

  test("deregisters with platform and signed headers only in versioned stdin", async () => {
    configureStewardSecrets();
    let capturedCommand = "";
    let capturedInput = "";
    const execStdin = mock(async (command: string, input: string | Buffer) => {
      capturedCommand = command;
      capturedInput = String(input);
      return "";
    });
    const ssh = { execStdin } as unknown as DockerSSHClient;

    await deregisterAgentWithSteward(ssh, "agent-23804", {
      tenantId: "tenant-23804",
      apiKey: TENANT_KEY_SENTINEL,
    });

    expect(execStdin).toHaveBeenCalledTimes(1);
    const frame = decodeJsonFrame(capturedInput);
    expect(frame.header).toBe("ELIZA_STEWARD_SSH_STDIN_V1:steward-agent-delete");
    expect(frame.end).toBe("ELIZA_STEWARD_SSH_STDIN_END");
    const headers = frame.payload.headers as Record<string, string>;
    expect(headers["X-Steward-Platform-Key"]).toBe(PLATFORM_KEY_SENTINEL);
    expect(headers["x-steward-signature"]).toStartWith("v1=");
    expectCommandHasNoAuthMaterial(capturedCommand, [headers]);
  });

  test("rejects malformed or oversized frames without reflecting received bytes", async () => {
    configureStewardSecrets();
    const request = await buildRegisterAgentWithStewardRequest(
      "agent-23804",
      "Secret transport sentinel",
      "tenant-23804",
      TENANT_KEY_SENTINEL,
    );
    const malformedInputs = [
      request.input.slice(0, -"ELIZA_STEWARD_SSH_STDIN_END\n".length),
      `${request.input}raw-error-sentinel-${PLATFORM_KEY_SENTINEL}`,
    ];

    for (const input of malformedInputs) {
      const result = await runRemoteCommand(request.command, input);
      expect(result.code).toBe(64);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Invalid Steward stdin payload");
      expect(result.stderr).not.toContain(PLATFORM_KEY_SENTINEL);
      expect(result.stderr).not.toContain(SIGNING_SECRET_SENTINEL);
    }

    process.env.STEWARD_PLATFORM_KEY = "x".repeat(300 * 1024);
    delete process.env.STEWARD_REQUEST_SIGNING_SECRET;
    await expect(
      buildSignedDeleteAgentRequest("agent-23804", { tenantId: "tenant-23804" }),
    ).rejects.toThrow("Invalid Steward stdin payload size");
  });

  test("executes register and delete successfully without placing auth in the command", async () => {
    const observations: Array<{ method: string; path: string; platformKey: string | undefined }> =
      [];
    const server = await listen((request, response) => {
      finishRequest(request, () => {
        observations.push({
          method: request.method ?? "",
          path: request.url ?? "",
          platformKey: request.headers["x-steward-platform-key"] as string | undefined,
        });
        if (request.method === "DELETE") {
          response.writeHead(204);
          response.end();
          return;
        }
        response.writeHead(201, { "content-type": "application/json" });
        response.end(
          request.url?.endsWith("/token") ? JSON.stringify({ token: "live-token" }) : "{}",
        );
      });
    });

    try {
      configureStewardSecrets(server.url);
      const ssh = executingSsh();
      const token = await registerAgentWithSteward(
        ssh,
        "agent-23804",
        "Secret transport sentinel",
        "tenant-23804",
        TENANT_KEY_SENTINEL,
      );
      expect(token).toBe("live-token");
      await deregisterAgentWithSteward(ssh, "agent-23804", {
        tenantId: "tenant-23804",
        apiKey: TENANT_KEY_SENTINEL,
      });
      expect(observations).toEqual([
        {
          method: "POST",
          path: "/platform/tenants/tenant-23804/agents",
          platformKey: PLATFORM_KEY_SENTINEL,
        },
        {
          method: "POST",
          path: "/platform/tenants/tenant-23804/agents/agent-23804/token",
          platformKey: PLATFORM_KEY_SENTINEL,
        },
        {
          method: "DELETE",
          path: "/platform/tenants/tenant-23804/agents/agent-23804",
          platformKey: PLATFORM_KEY_SENTINEL,
        },
      ]);
    } finally {
      await server.close();
    }
  });

  test("refuses redirects for register and delete without following credentials", async () => {
    let redirectHits = 0;
    let sinkHits = 0;
    const sink = await listen((request, response) => {
      finishRequest(request, () => {
        sinkHits += 1;
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({ token: "redirect-must-not-succeed" }));
      });
    });
    const redirector = await listen((request, response) => {
      finishRequest(request, () => {
        redirectHits += 1;
        response.writeHead(302, { location: `${sink.url}/capture` });
        response.end();
      });
    });

    try {
      configureStewardSecrets(redirector.url);
      const ssh = executingSsh();
      await expect(
        registerAgentWithSteward(
          ssh,
          "agent-redirect-23804",
          "Redirect sentinel",
          "tenant-23804",
          TENANT_KEY_SENTINEL,
        ),
      ).rejects.toThrow(/status 302/);
      await expect(
        deregisterAgentWithSteward(ssh, "agent-redirect-23804", {
          tenantId: "tenant-23804",
          apiKey: TENANT_KEY_SENTINEL,
        }),
      ).rejects.toThrow(/status 302/);
      expect(redirectHits).toBe(2);
      expect(sinkHits).toBe(0);
    } finally {
      await Promise.all([redirector.close(), sink.close()]);
    }
  });

  test("does not reflect Steward error bodies into loggable errors", async () => {
    let reflectedHeaderValues: string[] = [];
    const server = await listen((request, response) => {
      finishRequest(request, () => {
        reflectedHeaderValues = Object.entries(request.headers)
          .filter(([name]) => name.startsWith("x-steward-"))
          .flatMap(([, value]) => (Array.isArray(value) ? value : value ? [value] : []));
        response.writeHead(500, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            reflectedHeaderValues,
            rawSecrets: [PLATFORM_KEY_SENTINEL, SIGNING_SECRET_SENTINEL, TENANT_KEY_SENTINEL],
          }),
        );
      });
    });

    try {
      configureStewardSecrets(server.url);
      const ssh = executingSsh();
      let loggableError = "";
      try {
        await registerAgentWithSteward(
          ssh,
          "agent-reflection-23804",
          "Reflection sentinel",
          "tenant-23804",
          TENANT_KEY_SENTINEL,
        );
      } catch (error) {
        loggableError = error instanceof Error ? error.message : String(error);
      }
      expect(loggableError).toContain("status 500");
      for (const value of [
        PLATFORM_KEY_SENTINEL,
        SIGNING_SECRET_SENTINEL,
        TENANT_KEY_SENTINEL,
        ...reflectedHeaderValues,
      ]) {
        expect(loggableError).not.toContain(value);
      }

      await expect(
        deregisterAgentWithSteward(ssh, "agent-reflection-23804", {
          tenantId: "tenant-23804",
          apiKey: TENANT_KEY_SENTINEL,
        }),
      ).rejects.toThrow(/status 500/);
    } finally {
      await server.close();
    }
  });
});

describe("DockerSandboxProvider remaining secret stdin transports (#23804)", () => {
  const managedEnvironment = {
    ELIZAOS_CLOUD_API_KEY: CLOUD_API_KEY_SENTINEL,
    ELIZAOS_CLOUD_BASE_URL: "https://api.example.invalid/api/v1",
    ELIZA_CLOUD_AGENT_ID: "agent-23804",
  };

  test("writes host eliza.json through stdin and preserves runtime-readable metadata", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "eliza-23804-config-"));
    const volumePath = join(temporaryRoot, "agent-volume");
    try {
      await writeManagedElizaRuntimeConfig(
        executingSsh(),
        { kind: "host-volume", volumePath },
        managedEnvironment,
      );

      const configPath = join(volumePath, "eliza", "eliza.json");
      const configBytes = await readFile(configPath, "utf8");
      expect(JSON.parse(configBytes)).toMatchObject({
        cloud: { apiKey: CLOUD_API_KEY_SENTINEL },
      });
      expect((await stat(configPath)).mode & 0o777).toBe(0o644);

      await chmod(configPath, 0o640);
      const existingMetadata = await stat(configPath);
      await writeManagedElizaRuntimeConfig(
        executingSsh(),
        { kind: "host-volume", volumePath },
        { ...managedEnvironment, ELIZAOS_CLOUD_API_KEY: "replacement-cloud-key" },
      );
      const replacedMetadata = await stat(configPath);
      expect(replacedMetadata.mode & 0o777).toBe(0o640);
      expect(replacedMetadata.uid).toBe(existingMetadata.uid);
      expect(replacedMetadata.gid).toBe(existingMetadata.gid);
      expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
        cloud: { apiKey: "replacement-cloud-key" },
      });
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  test("writes container eliza.json without secret or reversible encoding in argv", async () => {
    let capturedCommand = "";
    let capturedInput = "";
    const exec = mock(async () => {
      throw new Error("secret-bearing config must not use exec");
    });
    const execStdin = mock(async (command: string, input: string | Buffer) => {
      capturedCommand = command;
      capturedInput = String(input);
      return "";
    });
    const ssh = { exec, execStdin } as unknown as DockerSSHClient;

    await writeManagedElizaRuntimeConfig(
      ssh,
      { kind: "container", containerName: "agent-23804" },
      managedEnvironment,
    );

    expect(exec).not.toHaveBeenCalled();
    expect(execStdin).toHaveBeenCalledTimes(1);
    expect(capturedCommand).toContain("docker exec -i");
    expect(capturedCommand).not.toContain(CLOUD_API_KEY_SENTINEL);
    expect(capturedCommand).not.toContain(Buffer.from(CLOUD_API_KEY_SENTINEL).toString("base64"));
    expect(JSON.parse(capturedInput)).toMatchObject({
      cloud: { apiKey: CLOUD_API_KEY_SENTINEL },
    });
  });

  test("starts Steward refresh with its service token only on stdin", async () => {
    let capturedCommand = "";
    let capturedInput = "";
    const exec = mock(async () => {
      throw new Error("Steward refresh must not use exec");
    });
    const execStdin = mock(async (command: string, input: string | Buffer) => {
      capturedCommand = command;
      capturedInput = String(input);
      return "";
    });
    const ssh = { exec, execStdin } as unknown as DockerSSHClient;

    await startStewardRefreshSidecar(
      ssh,
      "agent-23804",
      "agent-id-23804",
      REFRESH_SERVICE_TOKEN_SENTINEL,
    );

    expect(exec).not.toHaveBeenCalled();
    expect(execStdin).toHaveBeenCalledTimes(1);
    expect(capturedInput).toBe(REFRESH_SERVICE_TOKEN_SENTINEL);
    expect(capturedCommand).toContain("docker exec -i");
    expect(capturedCommand).toContain("docker exec -d");
    expect(capturedCommand).toContain('-H @"$auth_header_file"');
    expect(capturedCommand).toContain("/tmp/eliza-steward-refresh-service-token");
    expect(capturedCommand).not.toContain("/app/data/steward-refresh");
    expect(capturedCommand).toContain("trap cleanup_refresh_files EXIT");
    expect(capturedCommand).not.toContain(REFRESH_SERVICE_TOKEN_SENTINEL);
    expect(capturedCommand).not.toContain(
      Buffer.from(REFRESH_SERVICE_TOKEN_SENTINEL).toString("base64"),
    );
  });

  test("keeps the detached Steward refresh loop valid POSIX shell", () => {
    const script = buildStewardRefreshLoopScript("agent-id-23804");
    const syntax = spawnSync("/bin/sh", ["-n", "-c", script], { encoding: "utf8" });

    expect(syntax.status).toBe(0);
    expect(syntax.stderr).toBe("");
    expect(script).not.toContain("do;");
    expect(script).not.toContain("then;");
    expect(script).not.toContain("else;");
  });

  test("rejects unsafe Steward refresh tokens before SSH mutation", async () => {
    const execStdin = mock(async () => "");
    const ssh = { execStdin } as unknown as DockerSSHClient;

    for (const token of ["", "line-one\nline-two", "x".repeat(8 * 1024 + 1)]) {
      await expect(
        startStewardRefreshSidecar(ssh, "agent-23804", "agent-id-23804", token),
      ).rejects.toThrow("Invalid Steward refresh service token stdin payload");
    }
    expect(execStdin).not.toHaveBeenCalled();
  });
});

describe.skipIf(!RUN_REAL_DOCKER)(
  "DockerSandboxProvider Steward refresh — real Docker opt-in (#23804)",
  () => {
    test("starts the exact detached loop and removes transient bearer files", async () => {
      const containerName = `eliza-steward-refresh-proof-23804-${process.pid}`;
      const docker = (args: string[], input?: string) =>
        spawnSync("docker", args, {
          encoding: "utf8",
          input,
          maxBuffer: 4 * 1024 * 1024,
        });

      try {
        docker(["rm", "-f", containerName]);
        const started = docker([
          "run",
          "-d",
          "--rm",
          "--name",
          containerName,
          "alpine:3.23",
          "/bin/sleep",
          "300",
        ]);
        expect(started.status, started.stderr).toBe(0);

        const curlStub = docker(
          [
            "exec",
            "-i",
            containerName,
            "sh",
            "-c",
            "cat > /usr/local/bin/curl && chmod 755 /usr/local/bin/curl",
          ],
          "#!/bin/sh\nprintf '%s\\n' '{\"token\":\"jwt-from-refresh\"}'\n",
        );
        expect(curlStub.status, curlStub.stderr).toBe(0);
        const sleepStub = docker(
          [
            "exec",
            "-i",
            containerName,
            "sh",
            "-c",
            "cat > /usr/local/bin/sleep && chmod 755 /usr/local/bin/sleep && mkdir -p /app/data",
          ],
          "#!/bin/sh\nexit 7\n",
        );
        expect(sleepStub.status, sleepStub.stderr).toBe(0);

        await startStewardRefreshSidecar(
          executingSsh(),
          containerName,
          "agent-id-23804",
          REFRESH_SERVICE_TOKEN_SENTINEL,
        );

        let proof = docker(["exec", containerName, "false"]);
        for (let attempt = 0; attempt < 200; attempt++) {
          proof = docker([
            "exec",
            containerName,
            "sh",
            "-c",
            [
              "test -f /app/data/steward.jwt",
              "test ! -e /tmp/eliza-steward-refresh-service-token",
              "test ! -e /tmp/eliza-steward-refresh-authorization.header",
              'test "$(stat -c %a /app/data/steward.jwt)" = 600',
              "cat /app/data/steward.jwt",
            ].join(" && "),
          ]);
          if (proof.status === 0) break;
          await Bun.sleep(10);
        }

        expect(proof.status, `${proof.stderr}${proof.stdout}`).toBe(0);
        expect(proof.stdout).toBe("jwt-from-refresh");
      } finally {
        docker(["rm", "-f", containerName]);
      }
    }, 30_000);
  },
);
