/**
 * Real loopback SSH sessions prove framed restore input remains open until
 * acknowledgement and cancellation closes the peer channel. The server is
 * test-owned, bound only to loopback, with an ephemeral in-memory host key;
 * no Docker node, user credential or external infrastructure is involved.
 */
import { describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { Server, type ServerChannel, utils } from "ssh2";
import { DockerSSHClient } from "./docker-ssh";

async function withLoopback(
  receive: (channel: ServerChannel) => void,
  exercise: (client: DockerSSHClient) => Promise<void>,
) {
  const key = Buffer.from(
    generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    }).privateKey,
  );
  const parsed = utils.parseKey(key);
  if (parsed instanceof Error || Array.isArray(parsed)) throw new Error("Invalid fixture key");
  const pin = createHash("sha256").update(parsed.getPublicSSH()).digest("base64");
  const errors: Error[] = [];
  const server = new Server({ hostKeys: [key] }, (connection) => {
    connection.on("error", (error) => errors.push(error));
    connection.on("authentication", (context) => {
      if (context.username === "restore-fixture" && context.method === "none") context.accept();
      else context.reject();
    });
    connection.on("session", (accept) => {
      accept().on("exec", (acceptExec, reject, info) => {
        if (info.command !== "framed-restore-fixture") {
          reject();
          return;
        }
        const channel = acceptExec();
        channel.on("error", (error) => errors.push(error));
        receive(channel);
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing loopback address");
  const client = new DockerSSHClient({
    hostname: "127.0.0.1",
    port: address.port,
    username: "restore-fixture",
    privateKey: key,
    hostKeyFingerprint: pin,
  });
  try {
    await exercise(client);
  } finally {
    await client.disconnect();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    key.fill(0);
  }
  expect(errors).toEqual([]);
}

describe("framed restore over native SSH", () => {
  test("receives all bytes without EOF and accepts a fragmented exact receipt", async () => {
    const frame = Buffer.alloc(256 * 1024, 117);
    const digest = createHash("sha256").update(frame).digest("hex");
    let receivedBytes = 0;
    let earlyEof = false;
    let acknowledged = false;
    let receivedDigest = "";
    await withLoopback(
      (channel) => {
        const hash = createHash("sha256");
        channel.on("end", () => {
          if (!acknowledged) earlyEof = true;
        });
        channel.on("data", (chunk: Buffer) => {
          hash.update(chunk);
          receivedBytes += chunk.length;
          chunk.fill(0);
          if (receivedBytes !== frame.length) return;
          receivedDigest = hash.digest("hex");
          // Let an incorrectly sent SSH EOF arrive before acknowledging.
          setTimeout(() => {
            acknowledged = true;
            channel.write(receivedDigest.slice(0, 13));
            channel.write(receivedDigest.slice(13));
            channel.exit(earlyEof ? 1 : 0);
            channel.end();
          }, 30);
        });
      },
      async (client) => {
        await client.execStdinAbortable(
          "framed-restore-fixture",
          frame,
          new AbortController().signal,
          5_000,
          digest,
        );
      },
    );
    expect(receivedBytes).toBe(frame.length);
    expect(receivedDigest).toBe(digest);
    expect(earlyEof).toBe(false);
    expect(acknowledged).toBe(true);
    frame.fill(0);
  }, 10_000);

  test("cancellation closes the real peer channel before allowing a retry", async () => {
    const controller = new AbortController();
    const reason = new Error("restore lease lost");
    let peerClosed = false;
    let inputReceived = false;
    await withLoopback(
      (channel) => {
        channel.on("close", () => {
          peerClosed = true;
        });
        channel.on("data", (chunk: Buffer) => {
          inputReceived = true;
          chunk.fill(0);
          controller.abort(reason);
        });
      },
      async (client) => {
        await expect(
          client.execStdinAbortable(
            "framed-restore-fixture",
            Buffer.from("owned-frame"),
            controller.signal,
            5_000,
            "a".repeat(64),
          ),
        ).rejects.toBe(reason);
        expect(peerClosed).toBe(true);
      },
    );
    expect(inputReceived).toBe(true);
  }, 10_000);
});
