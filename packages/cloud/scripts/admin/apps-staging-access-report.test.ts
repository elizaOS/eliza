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
  for (const [index, sample] of [
    { role: "apps-worker", status: "running", private_net: [] },
    {
      role: "apps-control",
      status: "off",
      private_net: [{ ip: "10.0.0.34" }],
    },
    {
      role: "app-node",
      status: "running",
      private_net: [{ ip: "10.0.0.35" }],
    },
    { role: "tenant-db", status: "running", private_net: [] },
  ].entries())
    servers.push({
      id: index + 33,
      name: `PRIVATE_ROLE_CANARY_${index}`,
      status: sample.status,
      public_net: {
        ipv4: { ip: `192.0.2.${index + 33}`, blocked: false },
        ipv6: null,
      },
      private_net: sample.private_net,
      labels: { role: sample.role, environment: "staging" },
    });
  let providerServers = servers;
  const endpoint = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      requests.push(`${request.method} ${url.pathname}${url.search}`);
      const second = url.searchParams.get("page") === "2";
      return Response.json({
        servers: second
          ? providerServers.slice(1)
          : providerServers.slice(0, 1),
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
    expect(report.stagingControlRoleCandidates).toEqual({
      appsControlCount: 2,
      appsWorkerCount: 1,
      runningCount: 2,
      // The stopped control host has an attachment too. This does not prove
      // either attachment belongs to the staging apps network.
      privateNetworkAttachmentObservedCount: 2,
    });
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
    for (const server of servers) {
      expect(output).not.toContain(String(server.id));
      expect(output).not.toContain(server.name);
      expect(output).not.toContain(server.public_net.ipv4.ip);
      for (const network of server.private_net)
        expect(output).not.toContain(network.ip);
    }
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
    // A provider inventory with only another environment's control host and
    // staging app/database nodes has no staging control-role candidate.
    providerServers = servers.filter((server) =>
      [32, 35, 36].includes(server.id),
    );
    requests.length = 0;
    const withoutControl = classifyAppsStagingHost(await client.listServers(), [
      "192.0.2.99",
    ]);
    expect(requests).toEqual(["GET /v1/servers", "GET /v1/servers?page=2"]);
    expect(withoutControl.stagingControlRoleCandidates).toEqual({
      appsControlCount: 0,
      appsWorkerCount: 0,
      runningCount: 0,
      privateNetworkAttachmentObservedCount: 0,
    });
    expect(withoutControl.configuredHostMatchCount).toBe(0);
    expect(withoutControl.matchingServer).toBeNull();
    expect(withoutControl.guestAuthorizationVerified).toBe(false);
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
