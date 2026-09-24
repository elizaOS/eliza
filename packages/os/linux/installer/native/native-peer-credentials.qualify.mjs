import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";

const addonPath = process.argv[2];
if (!addonPath) throw new Error("native addon path is required");
if (process.platform !== "linux") {
  throw new Error("native peer qualification requires Linux");
}

const binding = createRequire(import.meta.url)(addonPath);
const socketPath = `${addonPath}.sock`;
const server = createServer();
let child;
let acceptedSocket;
let peer;

function closeServer() {
  return new Promise((resolve) => server.close(() => resolve()));
}

function waitForChildExit(processHandle) {
  return new Promise((resolve, reject) => {
    processHandle.once("error", reject);
    processHandle.once("exit", (code, signal) => {
      if (code === 0 && signal === null) resolve();
      else reject(new Error(`qualification client exited ${code ?? signal}`));
    });
  });
}

try {
  const accepted = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.once("connection", (socket) => {
      try {
        const descriptor = socket._handle?.fd;
        assert.ok(Number.isInteger(descriptor) && descriptor >= 0);
        resolve({ socket, peer: binding.capture(descriptor) });
      } catch (error) {
        reject(error);
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });

  const clientSource = `
    const { connect } = require("node:net");
    const socket = connect(process.argv[1]);
    socket.once("data", () => socket.end());
    socket.once("error", (error) => { throw error; });
  `;
  child = spawn(process.execPath, ["-e", clientSource, socketPath], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  const childExit = waitForChildExit(child);
  ({ socket: acceptedSocket, peer } = await accepted);

  assert.equal(peer.pid, child.pid);
  assert.equal(peer.uid, process.getuid());
  assert.equal(peer.gid, process.getgid());
  assert.equal(peer.isAlive(), true);

  acceptedSocket.end("exit");
  await childExit;
  assert.equal(peer.isAlive(), false);

  peer.close();
  assert.throws(() => peer.isAlive(), /closed/);
  peer = undefined;
  process.stdout.write(
    "QUALIFIED accepted cross-process SO_PEERCRED and SO_PEERPIDFD lifecycle\n",
  );
} finally {
  peer?.close();
  acceptedSocket?.destroy();
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
  if (server.listening) await closeServer();
}
