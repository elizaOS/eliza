import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HetznerCloudClient } from "../../shared/src/lib/services/containers/hetzner-cloud-api";
import {
  appsStagingReportFailure,
  classifyAppsStagingHost,
  configuredDeployKeyFingerprint,
} from "./apps-staging-access-report";

test("real provider client traverses GET pages; report excludes private inventory bytes and rejects ambiguity", async () => {
  const requests: string[] = [];
  const servers = [
    {
      id: 31,
      name: "PRIVATE_SERVER_CANARY",
      status: "running",
      public_net: { ipv4: { ip: "192.0.2.31", blocked: false }, ipv6: null },
      private_net: [{ ip: "10.0.0.31" }],
      labels: {
        role: "apps-control",
        environment: "staging",
        secret: "PRIVATE_LABEL_CANARY",
      },
    },
    {
      id: 32,
      name: "PRIVATE_OTHER_CANARY",
      status: "running",
      public_net: { ipv4: { ip: "192.0.2.32", blocked: false }, ipv6: null },
      private_net: [{ ip: "10.0.0.31" }],
      labels: { role: "apps-control", environment: "production" },
    },
  ];
  const endpoint = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      requests.push(`${request.method} ${url.pathname}${url.search}`);
      const second = url.searchParams.get("page") === "2";
      return Response.json({
        servers: [servers[second ? 1 : 0]],
        meta: { pagination: { next_page: second ? null : 2 } },
      });
    },
  });
  try {
    const client = HetznerCloudClient.withTestTransport("CLOSED_TEST_TOKEN", {
      apiBaseUrl: `http://127.0.0.1:${endpoint.port}/v1`,
    });
    const inventory = await client.listServers();
    expect(requests).toEqual(["GET /v1/servers", "GET /v1/servers?page=2"]);
    const report = classifyAppsStagingHost(inventory, ["192.0.2.31"]);
    expect(report.configuredHostMatchCount).toBe(1);
    expect(report.matchingServer).toEqual({
      running: true,
      environment: "staging",
      role: "apps-control",
      publicAddressMatch: true,
      privateAddressMatch: false,
    });
    expect(report.guestAuthorizationVerified).toBe(false);
    const output = JSON.stringify(report);
    for (const value of [
      "PRIVATE_SERVER_CANARY",
      "PRIVATE_LABEL_CANARY",
      "192.0.2.31",
      "10.0.0.31",
      "CLOSED_TEST_TOKEN",
    ])
      expect(output).not.toContain(value);
    const ambiguous = classifyAppsStagingHost(inventory, ["10.0.0.31"]);
    expect(ambiguous.configuredHostMatchCount).toBe(2);
    expect(ambiguous.matchingServer).toBeNull();
    expect(
      classifyAppsStagingHost(inventory, ["192.0.2.99"])
        .configuredHostMatchCount,
    ).toBe(0);
    expect(
      classifyAppsStagingHost(inventory, ["192.0.2.32"]).matchingServer
        ?.environment,
    ).toBe("unverified");
  } finally {
    endpoint.stop(true);
  }
});

test("actual ssh-keygen accepts configured key, omits comments, and sanitizes unreadable keys", () => {
  const directory = mkdtempSync(join(tmpdir(), "apps-staging-test-"));
  const keyDirectories = readdirSync(tmpdir()).filter((name) =>
    name.startsWith("apps-staging-key-"),
  );
  try {
    const path = join(directory, "key");
    execFileSync("ssh-keygen", [
      "-q",
      "-t",
      "ed25519",
      "-N",
      "",
      "-C",
      "PRIVATE_KEY_COMMENT_CANARY",
      "-f",
      path,
    ]);
    const privateKey = readFileSync(path, "utf8");
    const expected = execFileSync(
      "ssh-keygen",
      ["-E", "sha256", "-lf", `${path}.pub`],
      { encoding: "utf8" },
    ).split(/\s+/)[1];
    expect(configuredDeployKeyFingerprint(privateKey)).toBe(expected);
    expect(configuredDeployKeyFingerprint(privateKey)).not.toContain(
      "PRIVATE_KEY_COMMENT_CANARY",
    );
    expect(() =>
      configuredDeployKeyFingerprint("PRIVATE_INVALID_KEY_CANARY"),
    ).toThrow("configured_deploy_key_unreadable");
    const encrypted = join(directory, "encrypted");
    execFileSync("ssh-keygen", [
      "-q",
      "-t",
      "ed25519",
      "-N",
      "PRIVATE_PASSPHRASE_CANARY",
      "-f",
      encrypted,
    ]);
    expect(() =>
      configuredDeployKeyFingerprint(readFileSync(encrypted, "utf8")),
    ).toThrow("configured_deploy_key_unreadable");
    expect(
      readdirSync(tmpdir()).filter((name) =>
        name.startsWith("apps-staging-key-"),
      ),
    ).toEqual(keyDirectories);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CLI rejects provider origin override without leaking configured secret values", () => {
  const result = Bun.spawnSync(
    [
      process.execPath,
      "run",
      `${import.meta.dir}/apps-staging-access-report.ts`,
    ],
    {
      env: {
        ...process.env,
        NODE_ENV: "production",
        HCLOUD_API_BASE_URL: "https://PRIVATE_ORIGIN_CANARY.invalid",
        HCLOUD_APPS_TOKEN: "PRIVATE_TOKEN_CANARY",
        ELIZA_APPS_WORKER_HOST: "192.0.2.31",
        ELIZA_APPS_WORKER_SSH_KEY: "PRIVATE_KEY_CANARY",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(result.exitCode).toBe(1);
  expect(result.stdout.toString()).toContain(
    '"error":"provider_origin_not_pinned"',
  );
  for (const value of [
    "PRIVATE_ORIGIN_CANARY",
    "PRIVATE_TOKEN_CANARY",
    "PRIVATE_KEY_CANARY",
  ])
    expect(result.stdout.toString() + result.stderr.toString()).not.toContain(
      value,
    );
});

test("provider error body stays behind the report error boundary", async () => {
  const endpoint = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return Response.json(
        {
          error: {
            code: "unauthorized",
            message: "PRIVATE_PROVIDER_BODY_CANARY",
          },
        },
        { status: 401 },
      );
    },
  });
  try {
    const client = HetznerCloudClient.withTestTransport("CLOSED_TEST_TOKEN", {
      apiBaseUrl: `http://127.0.0.1:${endpoint.port}/v1`,
    });
    try {
      await client.listServers();
      throw new Error("expected provider rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "PRIVATE_PROVIDER_BODY_CANARY",
      );
      expect(appsStagingReportFailure(error)).toEqual({
        environment: "staging",
        guestAuthorizationVerified: false,
        error: "report_failed",
      });
      expect(JSON.stringify(appsStagingReportFailure(error))).not.toContain(
        "PRIVATE_PROVIDER_BODY_CANARY",
      );
    }
  } finally {
    endpoint.stop(true);
  }
});
