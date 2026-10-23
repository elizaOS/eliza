/**
 * The single-device adb proxy behind connectPlaywrightDevice. The adb server
 * here is a stand-in that speaks the adb wire format; no adb, emulator or
 * device is used.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import net from "node:net";
import { test } from "node:test";
import { connectPlaywrightDevice } from "./android-device.ts";
import {
  onlyDevice,
  singleDeviceDecision,
  startSingleDeviceAdb,
} from "./single-device-adb.ts";

const frame = (text: string) =>
  `${Buffer.byteLength(text).toString(16).padStart(4, "0")}${text}`;
const LISTING =
  "R58N12ABCDE\tdevice\nemulator-5556\toffline\nemulator-5554\tdevice\nemulator-55540\tdevice\n";

/** A stand-in adb server: records first requests, answers the listing, echoes a transport. */
async function fakeAdb(t: { after: (fn: () => unknown) => void }) {
  const seen: string[] = [];
  const server = net.createServer((socket) => {
    let text = "";
    let started = false;
    socket.on("data", (chunk) => {
      text += chunk.toString();
      if (text.length < 4) return;
      const length = Number.parseInt(text.slice(0, 4), 16);
      if (!started) {
        if (text.length < 4 + length) return;
        const command = text.slice(4, 4 + length);
        started = true;
        seen.push(command);
        if (command.startsWith("host:devices")) {
          socket.end(`OKAY${frame(LISTING)}`);
          return;
        }
        if (command === "host:version") {
          socket.end(`OKAY${frame("0029")}`);
          return;
        }
        socket.write("OKAY");
        text = text.slice(4 + length);
      }
      if (text.length) {
        socket.write(`echo:${text}`);
        text = "";
      }
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  );
  return { port: (server.address() as net.AddressInfo).port, seen };
}

/** Sends bytes; resolves with everything received until close or `until` matches. */
function exchange(port: number, writes: string[], until?: RegExp) {
  return new Promise<string>((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let text = "";
    socket.on("connect", () => {
      for (const write of writes) socket.write(write);
    });
    socket.on("data", (chunk) => {
      text += chunk.toString();
      if (until?.test(text)) {
        socket.destroy();
        resolve(text);
      }
    });
    socket.on("close", () => resolve(text));
    socket.on("error", reject);
  });
}

test("the proxy lists one device and refuses requests for any other", async (t) => {
  const adb = await fakeAdb(t);
  const endpoint = await startSingleDeviceAdb("emulator-5554", {
    adbPort: adb.port,
  });
  t.after(() => endpoint.close());
  assert.equal(
    await exchange(endpoint.port, [frame("host:devices")]),
    `OKAY${frame("emulator-5554\tdevice\n")}`,
  );
  assert.equal(
    await exchange(endpoint.port, [frame("host:version")]),
    `OKAY${frame("0029")}`,
  );
  // Its own transport passes through with what follows, also when split.
  assert.equal(
    await exchange(
      endpoint.port,
      [frame("host:transport:emulator-5554"), frame("shell:getprop x")],
      /echo:.*getprop x/,
    ),
    `OKAYecho:${frame("shell:getprop x")}`,
  );
  const split = frame("host:transport:emulator-5554");
  assert.match(
    await exchange(
      endpoint.port,
      [split.slice(0, 3), split.slice(3, 9), split.slice(9), "next"],
      /echo:next/,
    ),
    /^OKAYecho:next$/,
  );
  const before = adb.seen.length;
  const refused = [
    "host:transport:R58N12ABCDE",
    "host:transport:emulator-5556",
    "host:transport:emulator-55540",
    "host-serial:R58N12ABCDE:forward:tcp:0;localabstract:x",
    "host:transport-any",
    "host:transport-usb",
    "host:track-devices",
    "host:kill",
    "host-serial:emulator-5554:kill",
    "shell:id",
  ];
  for (const command of refused) {
    assert.equal(
      await exchange(endpoint.port, [frame(command)]),
      `FAIL${frame("This adb endpoint serves emulator-5554 only")}`,
      command,
    );
  }
  assert.equal(
    await exchange(endpoint.port, ["zzzz"]),
    `FAIL${frame("Malformed adb request")}`,
  );
  assert.equal(adb.seen.length, before, "no refused request was forwarded");
  assert.equal(endpoint.refused.length, refused.length);
});

test("decision and listing filter", () => {
  assert.equal(
    singleDeviceDecision("host:devices-l", "emulator-5554"),
    "filter",
  );
  assert.equal(
    singleDeviceDecision(
      "host-serial:emulator-5554:forward:tcp:0;localabstract:webview_devtools_remote_1",
      "emulator-5554",
    ),
    "forward",
  );
  // A network serial contains a colon; server control stays refused.
  assert.match(
    singleDeviceDecision("host-serial:10.0.0.2:5555:kill", "10.0.0.2:5555"),
    /only/,
  );
  assert.equal(onlyDevice(LISTING, "emulator-5554"), "emulator-5554\tdevice\n");
  assert.equal(onlyDevice(LISTING, "emulator-1"), "");
});

test("connectPlaywrightDevice with a serial sees only that device", async (t) => {
  const adb = await fakeAdb(t);
  const previousPort = process.env.ANDROID_ADB_SERVER_PORT;
  process.env.ANDROID_ADB_SERVER_PORT = String(adb.port);
  t.after(() => {
    if (previousPort === undefined) delete process.env.ANDROID_ADB_SERVER_PORT;
    else process.env.ANDROID_ADB_SERVER_PORT = previousPort;
  });
  let endpoint: { host: string; port: number } | undefined;
  // Stands in for Playwright's `_android`: lists devices over the adb wire.
  const android = {
    async devices(options: { host: string; port: number }) {
      endpoint = options;
      const answer = await exchange(options.port, [frame("host:devices")]);
      return onlyDeviceSerials(answer.slice(8)).map((serial) =>
        Object.assign(new EventEmitter(), { serial: () => serial }),
      );
    },
  };
  const device = await connectPlaywrightDevice(android, "emulator-5554");
  assert.equal(device.serial(), "emulator-5554");
  assert.ok(
    endpoint && endpoint.port !== adb.port,
    "Playwright used the proxy",
  );
  assert.deepEqual(adb.seen, ["host:devices"]);
  device.emit("close");
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    exchange(endpoint.port, [frame("host:devices")]),
    /ECONNREFUSED/,
    "the proxy closes with the device",
  );
});

function onlyDeviceSerials(listing: string) {
  return listing
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split(/\s+/)[0]);
}
