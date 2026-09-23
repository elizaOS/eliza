/**
 * Exercises real Linux abstract HTTP sockets, occupied-name refusal and shutdown.
 * Other hosts verify platform refusal, not Linux deployment qualification.
 */
import { randomUUID } from "node:crypto";
import { createServer, get } from "node:http";
import { connect } from "node:net";
import { describe, expect, it } from "vitest";
import { listenConfidentialUnix } from "./confidential-unix-listener";

function read(socketName: string): Promise<string> {
  return new Promise((resolve, reject) => {
    get(
      { socketPath: `\0${socketName}`, path: "/", agent: false },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => resolve(body));
        response.on("error", reject);
      },
    ).on("error", reject);
  });
}

const options = () => ({
  socketName: `eliza-test-${randomUUID()}`,
  drainTimeoutMs: 10,
  revokeAdmission: () => {},
});

describe.skipIf(process.platform !== "linux")(
  "confidential Unix listener",
  () => {
    it("serves HTTP without TCP and revokes admission before draining", async () => {
      const configuration = options();
      let admitted = true;
      const server = createServer((_req, res) =>
        res.end(admitted ? "admitted" : "denied"),
      );
      const listener = await listenConfidentialUnix({
        ...configuration,
        server,
        revokeAdmission: () => {
          admitted = false;
        },
      });
      try {
        expect(typeof server.address()).toBe("string");
        expect(await read(configuration.socketName)).toBe("admitted");
        const connection = connect(`\0${configuration.socketName}`);
        await new Promise<void>((resolve, reject) => {
          connection.once("connect", resolve);
          connection.once("error", reject);
        });
        const closed = new Promise<void>((resolve) =>
          connection.once("close", () => resolve()),
        );
        const stopped = listener.stop();
        expect(admitted).toBe(false);
        expect(listener.stop()).toBe(stopped);
        await stopped;
        await closed;
        expect(server.listening).toBe(false);
        await expect(read(configuration.socketName)).rejects.toMatchObject({
          code: "ECONNREFUSED",
        });
      } finally {
        await listener.stop();
      }
    });

    it("refuses an occupied name without disrupting its owner, then allows reuse", async () => {
      const configuration = options();
      const first = await listenConfidentialUnix({
        ...configuration,
        server: createServer((_req, res) => res.end("first")),
      });
      try {
        await expect(
          listenConfidentialUnix({ ...configuration, server: createServer() }),
        ).rejects.toMatchObject({ code: "CONFIDENTIAL_LISTENER_BIND_FAILED" });
        expect(await read(configuration.socketName)).toBe("first");
      } finally {
        await first.stop();
      }
      const second = await listenConfidentialUnix({
        ...configuration,
        server: createServer((_req, res) => res.end("second")),
      });
      try {
        await first.stop();
        expect(await read(configuration.socketName)).toBe("second");
      } finally {
        await second.stop();
      }
    });

    it("closes the listener even when admission teardown throws", async () => {
      const configuration = options();
      const server = createServer();
      const requested = new Promise<void>((resolve) => {
        server.once("request", () => resolve());
      });
      const listener = await listenConfidentialUnix({
        ...configuration,
        server,
        drainTimeoutMs: 60_000,
        revokeAdmission: () => {
          throw new Error("teardown failed");
        },
      });
      const connection = connect(`\0${configuration.socketName}`);
      const transportErrors: NodeJS.ErrnoException[] = [];
      connection.on("error", (error: NodeJS.ErrnoException) => {
        transportErrors.push(error);
      });
      const closed = new Promise<void>((resolve) => {
        connection.once("close", () => resolve());
      });
      connection.write(
        "POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\nx",
      );
      await requested;
      await expect(listener.stop()).rejects.toMatchObject({
        code: "CONFIDENTIAL_LISTENER_REVOCATION_FAILED",
      });
      await closed;
      expect(
        transportErrors.every((error) => error.code === "ECONNRESET"),
      ).toBe(true);
      expect(server.listening).toBe(false);
      await expect(read(configuration.socketName)).rejects.toMatchObject({
        code: "ECONNREFUSED",
      });
    });
  },
);

it("rejects a filesystem pathname without binding", async () => {
  const server = createServer();
  await expect(
    listenConfidentialUnix({
      ...options(),
      server,
      socketName: "/tmp/eliza-api.sock",
    }),
  ).rejects.toMatchObject({
    code: "CONFIDENTIAL_LISTENER_CONFIGURATION_INVALID",
  });
  expect(server.listening).toBe(false);
});

it.skipIf(process.platform === "linux")(
  "refuses unsupported platforms before binding",
  async () => {
    const server = createServer();
    await expect(
      listenConfidentialUnix({ ...options(), server }),
    ).rejects.toMatchObject({
      code: "CONFIDENTIAL_LISTENER_CONFIGURATION_INVALID",
    });
    expect(server.listening).toBe(false);
  },
);
