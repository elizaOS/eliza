import net from "node:net";
import { randomUUID } from "node:crypto";

// The packaged Android runtime uses authenticated NDJSON over an abstract
// Unix socket. adb forwards that byte stream to this loopback TCP port.
export function androidSocketFetch(url, options = {}) {
  const address = new URL(url);
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    let buffered = "";
    let settled = false;
    const socket = net.createConnection({
      host: "127.0.0.1",
      port: Number(address.port),
    });
    const finish = (error, response) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", abort);
      socket.destroy();
      if (error) reject(error);
      else resolve(response);
    };
    const abort = () =>
      finish(options.signal.reason ?? new Error("Request aborted"));
    if (options.signal?.aborted) {
      abort();
      return;
    }
    options.signal?.addEventListener("abort", abort, { once: true });
    socket.on("error", (error) => finish(error));
    socket.on("end", () =>
      finish(new Error("Android bridge closed without a complete response")),
    );
    socket.on("connect", () =>
      socket.write(
        `${JSON.stringify({
          id,
          method: "http_request",
          payload: {
            path: address.pathname + address.search,
            method: options.method ?? "GET",
            headers: Object.fromEntries(new Headers(options.headers)),
            ...(options.body === undefined ? {} : { body: options.body }),
          },
        })}\n`,
      ),
    );
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffered += chunk;
      if (buffered.length > 16 * 1024 * 1024) {
        finish(new Error("Android bridge response exceeded 16 MiB"));
        return;
      }
      const end = buffered.indexOf("\n");
      if (end < 0) return;
      try {
        const frame = JSON.parse(buffered.slice(0, end));
        if (frame.id !== id || frame.ok !== true || !frame.result) {
          throw new Error(frame.error ?? "Invalid Android bridge response");
        }
        const result = frame.result;
        const body =
          result.bodyEncoding === "base64"
            ? Buffer.from(result.bodyBase64, "base64")
            : result.body;
        finish(
          null,
          new Response([204, 205, 304].includes(result.status) ? null : body, {
            status: result.status,
            headers: result.headers,
          }),
        );
      } catch (error) {
        finish(error);
      }
    });
  });
}
