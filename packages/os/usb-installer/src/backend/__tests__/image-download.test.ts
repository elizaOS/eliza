import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { downloadFile } from "../image-download";

it("publishes complete HTTP downloads and preserves cached bytes on failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "image-download-"));
  const destination = join(directory, "image.iso");
  const server = createServer((request, response) => {
    if (request.url === "/redirect" || request.url === "/loop") {
      response.writeHead(302, {
        location: request.url === "/loop" ? "/loop" : "/image",
      });
      response.end();
    } else if (request.url === "/broken") {
      response.writeHead(200, { "content-length": "7" });
      response.write("short");
      setImmediate(() => response.destroy());
    } else if (request.url === "/wrong-length") {
      response.writeHead(200, { "content-length": "5" });
      response.end("short");
    } else if (request.url?.startsWith("/chunked")) {
      response.writeHead(200);
      response.write("fix");
      response.end(
        request.url === "/chunked-short"
          ? ""
          : request.url === "/chunked-long"
            ? "ture-extra"
            : "ture",
      );
    } else if (request.url === "/image") {
      response.writeHead(200, { "content-length": "7" });
      response.end("fixture");
    } else {
      response.writeHead(503);
      response.end();
    }
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing listener address");
    const base = `http://127.0.0.1:${address.port}`;
    await downloadFile(`${base}/redirect`, destination, 7, () => {});
    expect(await readFile(destination, "utf8")).toBe("fixture");
    const progress: number[][] = [];
    await downloadFile(`${base}/chunked`, destination, 7, (received, total) => {
      progress.push([received, total]);
    });
    expect(await readFile(destination, "utf8")).toBe("fixture");
    expect(progress.at(-1)).toEqual([7, 7]);
    await writeFile(destination, "previous verified cache");
    for (const endpoint of [
      "/broken",
      "/wrong-length",
      "/unavailable",
      "/loop",
      "/chunked-short",
      "/chunked-long",
    ]) {
      await expect(
        downloadFile(`${base}${endpoint}`, destination, 7, () => {}),
      ).rejects.toBeInstanceOf(Error);
      expect(await readFile(destination, "utf8")).toBe(
        "previous verified cache",
      );
      expect(await readdir(directory)).toEqual(["image.iso"]);
    }
    const failure = new Error("progress failed");
    await expect(
      downloadFile(`${base}/image`, destination, 7, () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    const controller = new AbortController();
    await expect(
      downloadFile(
        `${base}/image`,
        destination,
        7,
        () => controller.abort(),
        controller.signal,
      ),
    ).rejects.toBeInstanceOf(Error);
    expect(await readFile(destination, "utf8")).toBe("previous verified cache");
    expect(await readdir(directory)).toEqual(["image.iso"]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
