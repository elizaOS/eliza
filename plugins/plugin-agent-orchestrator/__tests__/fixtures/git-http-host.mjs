#!/usr/bin/env node
/**
 * Standalone smart-HTTP git host for tests: serves every bare repo under the
 * directory given as argv[2] via `git http-backend` (the same CGI protocol
 * GitHub-compatible servers speak). Runs as a SEPARATE process because the
 * code under test pushes with execFileSync — a blocking call that would
 * deadlock an in-process server on the same event loop. Prints
 * `GIT_HTTP_HOST_READY <baseUrl>` on stdout once listening; exits with the
 * parent (stdin close) or on SIGTERM.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";

const root = process.argv[2];
if (!root) {
  process.stderr.write("usage: git-http-host.mjs <repos-root>\n");
  process.exit(2);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const child = spawn("git", ["http-backend"], {
    env: {
      ...process.env,
      GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: url.pathname,
      QUERY_STRING: url.searchParams.toString(),
      REQUEST_METHOD: req.method ?? "GET",
      CONTENT_TYPE: req.headers["content-type"] ?? "",
      CONTENT_LENGTH: req.headers["content-length"] ?? "",
      GIT_PROTOCOL: req.headers["git-protocol"] ?? "",
      REMOTE_ADDR: "127.0.0.1",
    },
  });
  req.pipe(child.stdin);
  let headerBuf = Buffer.alloc(0);
  let headersDone = false;
  child.stdout.on("data", (chunk) => {
    if (headersDone) {
      res.write(chunk);
      return;
    }
    headerBuf = Buffer.concat([headerBuf, chunk]);
    const idx = headerBuf.indexOf("\r\n\r\n");
    if (idx === -1) return;
    for (const line of headerBuf.subarray(0, idx).toString().split("\r\n")) {
      const sep = line.indexOf(": ");
      if (sep === -1) continue;
      const key = line.slice(0, sep);
      const value = line.slice(sep + 2);
      if (key.toLowerCase() === "status") {
        res.statusCode = Number.parseInt(value, 10);
      } else {
        res.setHeader(key, value);
      }
    }
    headersDone = true;
    res.write(headerBuf.subarray(idx + 4));
  });
  child.stdout.on("end", () => res.end());
  child.on("error", () => {
    if (!res.headersSent) res.statusCode = 500;
    res.end();
  });
});

server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  process.stdout.write(`GIT_HTTP_HOST_READY http://127.0.0.1:${port}\n`);
});

// Exit with the parent: the test holds our stdin open; when it dies, we do too.
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
process.stdin.on("close", () => process.exit(0));
