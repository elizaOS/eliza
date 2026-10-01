import { expect, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import { EmailService } from "./email";

test("SMTP submission receipts preserve acceptance, partial rejection, and socket cancellation", async () => {
  const keys = ["SMTP_HOST", "SMTP_PORT", "SMTP_USERNAME", "SMTP_PASSWORD", "SMTP_FROM"] as const;
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const sockets = new Set<Socket>();
  let mode: "accept" | "reject" | "partial" | "stall" = "accept";
  let submissions = 0;
  let dataReached = false;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {
      // error-policy:J5 cancellation closes the owned loopback transport.
    });
    socket.write("220 localhost ESMTP\r\n");
    let buffered = "";
    let receiving = false;
    let recipients = 0;
    socket.on("data", (chunk) => {
      buffered += chunk.toString();
      while (buffered.includes("\r\n")) {
        const end = buffered.indexOf("\r\n");
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
        if (receiving) {
          if (line === "." && mode !== "stall") {
            receiving = false;
            submissions++;
            socket.write("250 queued\r\n");
          }
        } else if (line.startsWith("EHLO")) {
          socket.write("250-localhost\r\n250 AUTH PLAIN\r\n");
        } else if (line.startsWith("AUTH PLAIN")) {
          socket.write("235 authenticated\r\n");
        } else if (line.startsWith("MAIL FROM")) {
          socket.write("250 sender accepted\r\n");
        } else if (line.startsWith("RCPT TO")) {
          recipients++;
          socket.write(
            mode === "reject" || (mode === "partial" && recipients > 1)
              ? "550 recipient rejected\r\n"
              : "250 recipient accepted\r\n",
          );
        } else if (line === "DATA") {
          receiving = true;
          dataReached = true;
          socket.write("354 send message\r\n");
        } else if (line === "QUIT") {
          socket.end("221 goodbye\r\n");
        } else {
          socket.write("250 OK\r\n");
        }
      }
    });
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing SMTP listener");
    Object.assign(process.env, {
      SMTP_HOST: "127.0.0.1",
      SMTP_PORT: String(address.port),
      SMTP_USERNAME: "fixture",
      SMTP_PASSWORD: "fixture",
      SMTP_FROM: "sender@example.test",
    });
    const options = {
      to: "first@example.test",
      subject: "Receipt integration",
      text: "Local SMTP only",
    };
    const accepted = await new EmailService().dispatch(options);
    expect(accepted).toMatchObject({ status: "accepted", provider: "smtp" });
    expect(submissions).toBe(1);
    mode = "reject";
    expect(await new EmailService().dispatch(options)).toEqual({
      status: "rejected",
      provider: "smtp",
      reason: "provider_rejected",
    });
    expect(submissions).toBe(1);
    mode = "partial";
    expect(
      await new EmailService().dispatch({ ...options, to: [options.to, "second@example.test"] }),
    ).toMatchObject({ status: "uncertain", provider: "smtp", reason: "partial_acceptance" });
    expect(submissions).toBe(2);
    mode = "stall";
    dataReached = false;
    expect(await new EmailService().dispatchBounded(options, 5_000)).toMatchObject({
      status: "uncertain",
      provider: "smtp",
      reason: "transport_error",
    });
    expect(dataReached).toBe(true);
    expect(submissions).toBe(2);
    // Allow the peer to observe the client's awaited physical socket closure.
    await Promise.all(
      [...sockets].map(
        (socket) =>
          new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(
              () => reject(new Error("SMTP peer did not observe cancellation")),
              2_000,
            );
            socket.once("close", () => {
              clearTimeout(timeout);
              resolve();
            });
          }),
      ),
    );
    expect(sockets.size).toBe(0);
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}, 30_000);
