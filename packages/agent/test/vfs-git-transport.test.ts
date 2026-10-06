import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import type { AddressInfo, LookupFunction } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import git from "isomorphic-git";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createVfsGitService } from "../src/services/vfs-git.ts";
import { VirtualFilesystemService } from "../src/services/virtual-filesystem.ts";

const hosts = ["github.com", "attacker.example", "github.com.attacker.example"];
const originalHttps = https.globalAgent;
const originalHttp = http.globalAgent;
const originalToken = process.env.GITHUB_TOKEN;
const originalPat = process.env.GITHUB_PAT;
const requests: Array<string | undefined> = [];
let directory: string;
let secure: https.Server;
let plain: http.Server;
let project = 0;

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "eliza-git-transport-"));
  const config = path.join(directory, "openssl.cnf");
  const keyPath = path.join(directory, "key.pem");
  const certPath = path.join(directory, "cert.pem");
  await writeFile(
    config,
    `[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=github.com\n[ext]\nsubjectAltName=${hosts.map((host) => `DNS:${host}`).join(",")}\n`,
  );
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-config",
      config,
      "-keyout",
      keyPath,
      "-out",
      certPath,
    ],
    { stdio: "ignore" },
  );
  const cert = await readFile(certPath);
  // Only these fixture hosts resolve, and all connections stay on loopback.
  // TLS still verifies the generated certificate and its requested hostname.
  const lookup: LookupFunction = (hostname, options, callback) => {
    if (!hosts.includes(hostname)) {
      callback(new Error(`Unexpected Git fixture host: ${hostname}`), "", 4);
      return;
    }
    callback(
      null,
      options.all ? [{ address: "127.0.0.1", family: 4 }] : "127.0.0.1",
      4,
    );
  };
  https.globalAgent = new https.Agent({ ca: cert, lookup });
  http.globalAgent = new http.Agent({ lookup });
  const challenge: http.RequestListener = (request, response) => {
    requests.push(request.headers.authorization);
    response.writeHead(401, {
      "WWW-Authenticate": 'Basic realm="git-fixture"',
    });
    response.end("Authentication required");
  };
  secure = https.createServer(
    { key: await readFile(keyPath), cert },
    challenge,
  );
  plain = http.createServer(challenge);
  await Promise.all(
    [secure, plain].map(
      (server) =>
        new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)),
    ),
  );
});

afterAll(async () => {
  if (https.globalAgent !== originalHttps) https.globalAgent.destroy();
  if (http.globalAgent !== originalHttp) http.globalAgent.destroy();
  https.globalAgent = originalHttps;
  http.globalAgent = originalHttp;
  for (const [key, value] of [
    ["GITHUB_TOKEN", originalToken],
    ["GITHUB_PAT", originalPat],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await Promise.all(
    [secure, plain]
      .filter((server) => server?.listening)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  );
  if (directory) await rm(directory, { recursive: true, force: true });
});

const cases = [
  [
    "HTTPS GitHub",
    "https",
    "github.com",
    "fixture-secret",
    "",
    "",
    "fixture-secret",
  ],
  ["plain HTTP GitHub", "http", "github.com", "fixture-secret", "", "", null],
  ["another host", "https", "attacker.example", "fixture-secret", "", "", null],
  [
    "a lookalike host",
    "https",
    "github.com.attacker.example",
    "fixture-secret",
    "",
    "",
    null,
  ],
  ["PAT fallback", "https", "github.com", "", "fixture-pat", "", "fixture-pat"],
  [
    "explicit credentials",
    "https",
    "attacker.example",
    "fixture-secret",
    "",
    "fixture-request",
    "fixture-request",
  ],
  ["no credentials", "https", "github.com", "  ", "", "", null],
] as const;

for (const action of ["clone", "fetch"] as const) {
  it.each(cases)(
    `${action} scopes actual HTTP credentials for %s`,
    async (_name, protocol, hostname, token, pat, explicit, expected) => {
      process.env.GITHUB_TOKEN = token;
      process.env.GITHUB_PAT = pat;
      requests.length = 0;
      const vfs = new VirtualFilesystemService({
        projectId: `fixture-${project++}`,
        stateDir: directory,
      });
      await vfs.initialize();
      const service = createVfsGitService(vfs);
      const port = (
        (protocol === "https" ? secure : plain).address() as AddressInfo
      ).port;
      const url = `${protocol}://${hostname}:${port}/repo.git`;
      if (action === "fetch") {
        await service.run({ action: "init" });
        await git.setConfig({
          fs,
          dir: vfs.filesRoot,
          path: "remote.origin.url",
          value: url,
        });
      }
      await expect(
        service.run({
          action,
          ...(action === "clone" ? { url } : { remote: "origin" }),
          ...(explicit ? { auth: { token: explicit } } : {}),
        }),
      ).rejects.toMatchObject({ code: "HttpError", data: { statusCode: 401 } });
      expect(requests.length).toBeGreaterThan(0);
      expect(requests.filter((value) => value !== undefined)).toEqual(
        expected
          ? [
              `Basic ${Buffer.from(`x-access-token:${expected}`).toString("base64")}`,
            ]
          : [],
      );
    },
  );
}
