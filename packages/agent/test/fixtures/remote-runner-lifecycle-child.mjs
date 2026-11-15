/** Real HTTP runner process for lifecycle tests; writes accepted requests to disk. */
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

const directory = process.argv[2];
let healthReleased = process.argv[3] !== "health";
let writesReleased = process.argv[3] !== "write";
const healthWaiters = [];
const writeWaiters = [];

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/v1/health") {
      process.send?.({ type: "health" });
      if (!healthReleased) {
        await new Promise((resolve) => healthWaiters.push(resolve));
      }
      response.end("{}");
      return;
    }
    if (url.pathname === "/v1/fs/file" && request.method === "PUT") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      process.send?.({ type: "write-received" });
      if (!writesReleased) {
        await new Promise((resolve) => writeWaiters.push(resolve));
      }
      const file = path.join(
        directory,
        path.basename(url.searchParams.get("path")),
      );
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, Buffer.concat(chunks));
      process.send?.({ type: "write-committed" });
      response.end("{}");
      return;
    }
    response.statusCode = 404;
    response.end("missing");
  } catch (error) {
    response.statusCode = 500;
    response.end(String(error));
  }
});

process.on("message", (message) => {
  if (message.type === "release-health" || message.type === "release-all") {
    healthReleased = true;
    for (const resolve of healthWaiters.splice(0)) resolve();
  }
  if (message.type === "release-write" || message.type === "release-all") {
    writesReleased = true;
    for (const resolve of writeWaiters.splice(0)) resolve();
  }
  if (message.type === "ping") process.send?.({ type: "pong" });
});
server.listen(0, "127.0.0.1", () => {
  process.send?.({ type: "ready", port: server.address().port });
});
