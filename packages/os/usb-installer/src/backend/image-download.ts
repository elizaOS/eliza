import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import * as http from "node:http";
import * as https from "node:https";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";

async function responseFor(
  url: URL,
  signal?: AbortSignal,
  redirects = 0,
): Promise<http.IncomingMessage> {
  signal?.throwIfAborted();
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("Unsupported image download protocol.");
  if (redirects > 10)
    throw new Error("Image download exceeded its redirect limit.");
  const response = await new Promise<http.IncomingMessage>(
    (resolve, reject) => {
      const request = (url.protocol === "https:" ? https : http).get(
        url,
        {
          headers: { "User-Agent": "elizaos-usb-installer/1.0" },
        },
        resolve,
      );
      request.setTimeout(30_000, () =>
        request.destroy(new Error("Image download stalled.")),
      );
      const abort = () => {
        // Do not inject an error into a socket that HTTP may have returned to
        // its pool after buffering the body. The operation preserves the reason.
        request.destroy();
        reject(signal?.reason ?? new Error("Image download cancelled."));
      };
      signal?.addEventListener("abort", abort, { once: true });
      request.once("close", () => signal?.removeEventListener("abort", abort));
      request.on("error", reject);
      if (signal?.aborted) abort();
    },
  );
  if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
    const location = response.headers.location;
    response.destroy();
    if (!location) throw new Error("Image redirect has no Location header.");
    const next = new URL(location, url);
    if (url.protocol === "https:" && next.protocol !== "https:")
      throw new Error("Image redirect cannot downgrade HTTPS.");
    return responseFor(next, signal, redirects + 1);
  }
  if (response.statusCode !== 200) {
    response.destroy();
    throw new Error(`HTTP ${response.statusCode ?? "?"} downloading ${url}`);
  }
  return response;
}

/** Publish complete downloads only; callers still authenticate the image bytes. */
export async function downloadFile(
  url: string,
  destination: string,
  expectedBytes: number,
  onProgress: (received: number, total: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0)
    throw new Error("Image size must be a positive safe integer.");
  await mkdir(dirname(destination), { recursive: true });
  const temporary = await mkdtemp(
    join(dirname(destination), ".image-download-"),
  );
  const errors: unknown[] = [];
  try {
    const response = await responseFor(new URL(url), signal);
    const declared = response.headers["content-length"];
    if (declared !== undefined && Number(declared) !== expectedBytes) {
      response.destroy();
      throw new Error("Image Content-Length does not match the expected size.");
    }
    let received = 0;
    async function* trackedResponse() {
      for await (const chunk of response) {
        received += chunk.length;
        if (received > expectedBytes)
          throw new Error("Image download exceeds the expected size.");
        onProgress(received, expectedBytes);
        signal?.throwIfAborted();
        yield chunk;
      }
    }
    const file = join(temporary, "image.partial");
    await pipeline(
      trackedResponse(),
      createWriteStream(file, { flags: "wx", mode: 0o600 }),
    );
    signal?.throwIfAborted();
    if (received !== expectedBytes)
      throw new Error("Image download does not match the expected size.");
    await rename(file, destination);
  } catch (error) {
    errors.push(signal?.aborted ? signal.reason : error);
  }
  try {
    await rm(temporary, { recursive: true, force: true });
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1)
    throw new AggregateError(errors, "Image download and cleanup failed.");
}
