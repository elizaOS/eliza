/**
 * An adb server endpoint that exposes one device only.
 *
 * Playwright's `_android.devices()` has no serial filter: it asks the adb
 * server for every attached device and opens a shell on each one (installing
 * its driver there). With a phone or another run's emulator attached, that
 * touches devices this run does not own, and one device that refuses fails the
 * whole listing.
 *
 * `startSingleDeviceAdb(serial)` listens on a loopback port and forwards to the
 * real adb server with two rules, so Playwright can be pointed at it with
 * `_android.devices({ host, port })`:
 *   - `host:devices` / `host:devices-l` answer with the line of `serial` only;
 *   - a request that names a device must name `serial`
 *     (`host:transport:<serial>`, `host-serial:<serial>:…`). `host:transport-any`
 *     and similar, device tracking and server control (`host:kill`) get adb's
 *     own FAIL answer and never reach the real server.
 * Everything after an accepted transport request is passed through unchanged.
 */
import net from "node:net";

export type SingleDeviceAdb = {
  host: string;
  port: number;
  serial: string;
  /** First requests that were refused (truncated), for diagnostics. */
  refused: string[];
  close(): Promise<void>;
};

const frame = (text: string) => {
  const body = Buffer.from(text);
  return Buffer.concat([
    Buffer.from(body.length.toString(16).padStart(4, "0")),
    body,
  ]);
};
const fail = (reason: string) =>
  Buffer.concat([Buffer.from("FAIL"), frame(reason)]);

/** What the endpoint does with a first request: filter, forward or refuse (reason). */
export function singleDeviceDecision(
  command: string,
  serial: string,
): "filter" | "forward" | string {
  if (command === "host:devices" || command === "host:devices-l")
    return "filter";
  if (command === "host:version") return "forward";
  if (
    command === `host:transport:${serial}` ||
    command === `host:tport:serial:${serial}`
  )
    return "forward";
  const serialPrefix = `host-serial:${serial}:`;
  if (
    command.startsWith(serialPrefix) &&
    !/^(?:kill|track-devices)/.test(command.slice(serialPrefix.length))
  )
    return "forward";
  return `This adb endpoint serves ${serial} only`;
}

/** The `host:devices` listing with every other device's line removed. */
export function onlyDevice(listing: string, serial: string): string {
  return listing
    .split("\n")
    .filter((line) => line.split(/\s+/)[0] === serial)
    .map((line) => `${line}\n`)
    .join("");
}

export async function startSingleDeviceAdb(
  serial: string,
  {
    adbHost = "127.0.0.1",
    adbPort = Number(process.env.ANDROID_ADB_SERVER_PORT) || 5037,
  }: { adbHost?: string; adbPort?: number } = {},
): Promise<SingleDeviceAdb> {
  if (!serial || /\s/.test(serial)) {
    throw new Error(`Invalid adb serial: ${JSON.stringify(serial)}`);
  }
  const sockets = new Set<net.Socket>();
  const refused: string[] = [];
  const server = net.createServer((client) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    client.on("error", () => client.destroy());
    let head = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      if (head.length < 4) return;
      const lengthHex = head.subarray(0, 4).toString("latin1");
      if (!/^[0-9a-fA-F]{4}$/.test(lengthHex)) {
        client.end(fail("Malformed adb request"));
        return;
      }
      const length = Number.parseInt(lengthHex, 16);
      if (head.length < 4 + length) return;
      client.off("data", onData);
      const command = head.subarray(4, 4 + length).toString("utf8");
      const decision = singleDeviceDecision(command, serial);
      if (decision !== "filter" && decision !== "forward") {
        refused.push(command.slice(0, 80));
        client.end(fail(decision));
        return;
      }
      const upstream = net.connect(adbPort, adbHost);
      sockets.add(upstream);
      upstream.on("close", () => {
        sockets.delete(upstream);
        client.end();
      });
      upstream.on("error", () => client.destroy());
      client.on("close", () => upstream.destroy());
      if (decision === "forward") {
        upstream.write(head);
        client.pipe(upstream);
        upstream.pipe(client, { end: false });
        return;
      }
      // The listing: the server closes after its answer; keep this device's line.
      const parts: Buffer[] = [];
      upstream.on("data", (part: Buffer) => parts.push(part));
      upstream.on("end", () => {
        const answer = Buffer.concat(parts);
        if (
          answer.subarray(0, 4).toString("latin1") !== "OKAY" ||
          answer.length < 8
        ) {
          client.end(fail("The adb server did not list its devices"));
          return;
        }
        client.end(
          Buffer.concat([
            Buffer.from("OKAY"),
            frame(onlyDevice(answer.subarray(8).toString("utf8"), serial)),
          ]),
        );
      });
      upstream.write(head.subarray(0, 4 + length));
    };
    client.on("data", onData);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as net.AddressInfo;
  return {
    host: "127.0.0.1",
    port: address.port,
    serial,
    refused,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
