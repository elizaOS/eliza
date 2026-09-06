/**
 * Exercises submission receipts through the real SMTP adapter on loopback and
 * the SendGrid response boundary. No messages leave the local test process.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import sgMail from "@sendgrid/mail";
import { EmailService } from "./email";

const keys = [
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_PASSWORD",
  "SMTP_USERNAME",
  "SENDGRID_API_KEY",
] as const;
const prior = new Map(keys.map((key) => [key, process.env[key]]));
const sockets = new Set<Socket>();
let server: Server | null = null;
let submissions = 0;
const restores: Array<() => void> = [];
const mail = {
  to: "recipient@example.test",
  subject: "Receipt contract",
  text: "Local fixture",
  html: "<p>Local fixture</p>",
};

beforeEach(() => {
  for (const key of keys) delete process.env[key];
  submissions = 0;
});
afterEach(async () => {
  for (const restore of restores.splice(0)) restore();
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  if (server) {
    const closing = server;
    server = null;
    await new Promise<void>((resolve, reject) =>
      closing.close((error) => (error ? reject(error) : resolve())),
    );
  }
  for (const [key, value] of prior) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function smtp(
  mode: "accept" | "disconnect" | "reject" | "partial" | "reject_all",
): Promise<void> {
  server = createServer((socket) => {
    sockets.add(socket);
    let pending = "";
    let data = false;
    socket.write("220 localhost ESMTP\r\n");
    socket.on("data", (chunk) => {
      pending += chunk.toString();
      let end: number;
      while ((end = pending.indexOf("\r\n")) >= 0) {
        const line = pending.substring(0, end);
        pending = pending.substring(end + 2);
        if (data) {
          if (line !== ".") continue;
          data = false;
          submissions += 1;
          if (mode === "disconnect") socket.destroy();
          else socket.write(mode === "reject" ? "550 Message rejected\r\n" : "250 queued\r\n");
        } else if (line.startsWith("EHLO")) socket.write("250-localhost\r\n250 AUTH PLAIN\r\n");
        else if (line.startsWith("AUTH")) socket.write("235 authenticated\r\n");
        else if (line.startsWith("DATA")) {
          data = true;
          socket.write("354 continue\r\n");
        } else if (line.startsWith("QUIT")) socket.end("221 bye\r\n");
        else if (mode === "reject_all" && line.startsWith("RCPT"))
          socket.write("550 recipient rejected\r\n");
        else if (mode === "partial" && line.includes("reject@example.test"))
          socket.write("550 recipient rejected\r\n");
        else socket.write("250 ok\r\n");
      }
    });
  });
  const listening = server;
  await new Promise<void>((resolve, reject) => {
    listening.once("error", reject);
    listening.listen(0, "127.0.0.1", resolve);
  });
  const address = listening.address();
  if (!address || typeof address === "string") throw new Error("Missing loopback listener");
  process.env.SMTP_HOST = "127.0.0.1";
  process.env.SMTP_PORT = String(address.port);
  process.env.SMTP_USERNAME = "fixture";
  process.env.SMTP_PASSWORD = "fixture-password";
}

describe("EmailService durable submission receipt", () => {
  test("makes unavailable configuration explicit and retains legacy false", async () => {
    const service = new EmailService();
    expect(await service.dispatch(mail)).toEqual({
      status: "unavailable",
      reason: "not_configured",
    });
    expect(await service.send(mail)).toBe(false);
  });
  test("records SMTP acceptance without claiming recipient delivery", async () => {
    await smtp("accept");
    const result = await new EmailService().dispatch(mail);
    expect(result).toMatchObject({ status: "accepted", provider: "smtp" });
    if (result.status !== "accepted") throw new Error("Expected SMTP acceptance");
    expect(result.messageId).toContain("@");
    expect(submissions).toBe(1);
    expect(JSON.stringify(result)).not.toContain(mail.to);
    expect(JSON.stringify(result)).not.toContain(mail.text);
  });
  test("disconnect after submission remains uncertain and is never retried", async () => {
    await smtp("disconnect");
    expect(await new EmailService().dispatch(mail)).toEqual({
      status: "uncertain",
      provider: "smtp",
      reason: "transport_error",
      messageId: null,
    });
    expect(submissions).toBe(1);
  });
  test("partial recipient acceptance cannot claim one complete receipt", async () => {
    await smtp("partial");
    expect(
      await new EmailService().dispatch({ ...mail, to: [mail.to, "reject@example.test"] }),
    ).toMatchObject({ status: "uncertain", provider: "smtp", reason: "partial_acceptance" });
    expect(submissions).toBe(1);
  });
  test("explicit SMTP rejection is distinct from uncertain acceptance", async () => {
    await smtp("reject");
    expect(await new EmailService().dispatch(mail)).toEqual({
      status: "rejected",
      provider: "smtp",
      reason: "provider_rejected",
    });
    expect(submissions).toBe(1);
  });
  test("all recipients rejected never submit a message", async () => {
    await smtp("reject_all");
    expect(await new EmailService().dispatch(mail)).toEqual({
      status: "rejected",
      provider: "smtp",
      reason: "provider_rejected",
    });
    expect(submissions).toBe(0);
  });
  test("legacy transport failure continues to reject", async () => {
    await smtp("reject");
    await expect(new EmailService().send(mail)).rejects.toThrow();
    expect(submissions).toBe(1);
  });
  test("malformed configured port is unavailable without opening a connection", async () => {
    process.env.SMTP_HOST = "127.0.0.1";
    process.env.SMTP_PORT = "invalid";
    process.env.SMTP_PASSWORD = "fixture-password";
    expect(await new EmailService().dispatch(mail)).toEqual({
      status: "unavailable",
      reason: "invalid_configuration",
    });
    expect(submissions).toBe(0);
  });
  test("maps SendGrid receipt, missing receipt, rejection and ambiguous failure separately", async () => {
    process.env.SENDGRID_API_KEY = "SG.test.fake";
    const setKey = spyOn(sgMail, "setApiKey").mockImplementation(() => undefined);
    const send = spyOn(sgMail, "send");
    restores.push(
      () => send.mockRestore(),
      () => setKey.mockRestore(),
    );
    send.mockResolvedValue([
      { statusCode: 202, headers: { "x-message-id": "receipt-123" }, body: {} },
      {},
    ]);
    expect(await new EmailService().dispatch(mail)).toEqual({
      status: "accepted",
      provider: "sendgrid",
      messageId: "receipt-123",
    });
    send.mockResolvedValue([{ statusCode: 202, headers: {}, body: {} }, {}]);
    expect(await new EmailService().dispatch(mail)).toMatchObject({
      status: "uncertain",
      reason: "missing_receipt",
    });
    send.mockRejectedValue(Object.assign(new Error("private transport payload"), { code: 401 }));
    expect(await new EmailService().dispatch(mail)).toEqual({
      status: "rejected",
      provider: "sendgrid",
      reason: "provider_rejected",
    });
    send.mockRejectedValue(Object.assign(new Error("private transport payload"), { code: 503 }));
    expect(await new EmailService().dispatch(mail)).toEqual({
      status: "uncertain",
      provider: "sendgrid",
      reason: "transport_error",
      messageId: null,
    });
    send.mockRejectedValue(Object.assign(new Error("private timeout payload"), { code: 408 }));
    expect(await new EmailService().dispatch(mail)).toMatchObject({
      status: "uncertain",
      reason: "transport_error",
    });
    send.mockResolvedValue([
      {
        statusCode: 202,
        headers: { "x-message-id": "private\r\nAuthorization: bearer-secret" },
        body: {},
      },
      {},
    ]);
    const unsafeReceipt = await new EmailService().dispatch(mail);
    expect(unsafeReceipt).toMatchObject({
      status: "uncertain",
      reason: "missing_receipt",
      messageId: null,
    });
    expect(JSON.stringify(unsafeReceipt)).not.toContain("bearer-secret");
    expect(send).toHaveBeenCalledTimes(6);
  });
});
