import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { NativeHostError } from "./errors.mjs";
import { validateTraceEvent } from "./research-store.mjs";
import { createTaskTraceCapture as createPilotTaskCapture } from "./task-trace-capture.mjs";
import { createTraceTransport } from "./trace-transport.mjs";

const createPilotTransport = (options) =>
  createTraceTransport({ ...options, validateEvent: validateTraceEvent });

import { openTraceQueue as openQueue } from "./trace-queue.mjs";

const openTraceQueue = (options) =>
  openQueue({ ...options, validateEvent: validateTraceEvent });

import { acquireExclusiveDatabaseLease as acquirePilotLease } from "./database-lease.mjs";
export function readResearchProducerConfiguration(path) {
  if (!path || !isAbsolute(path))
    throw new NativeHostError(
      "Absolute private producer configuration required",
    );
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    stat.size > 65536
  )
    throw new NativeHostError("Private producer configuration required");
  let config;
  try {
    config = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new NativeHostError("Invalid private pilot configuration JSON");
  }
  if (
    !isAbsolute(config.queuePath) ||
    !/^[a-f0-9]{64}$/.test(config.ownerSha256) ||
    ![config.participantId, config.deviceId].every(
      (v) => typeof v === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(v),
    ) ||
    ![config.encryptionKey, config.pseudonymKey].every(
      (v) => typeof v === "string" && Buffer.from(v, "base64").length === 32,
    )
  )
    throw new NativeHostError("Invalid pilot producer binding");
  const directory = lstatSync(dirname(config.queuePath));
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    (directory.mode & 0o077) !== 0
  )
    throw new NativeHostError("Private producer directory required");
  return config;
}
/** Called explicitly by a configured trusted host after it creates its gateway. */
export function startResearchCapture({
  gateway,
  config,
  onStatus = () => {},
  intervalMs = 1000,
}) {
  if (!Number.isInteger(intervalMs) || intervalMs < 10 || intervalMs > 60000)
    throw new NativeHostError("Invalid pilot capture interval");
  const cancellation = new AbortController();
  const transport = createPilotTransport({
    url: config.collectorUrl,
    token: config.deviceToken,
    signal: cancellation.signal,
  });
  const release = acquirePilotLease(config.queuePath);
  let queue;
  try {
    queue = openTraceQueue({
      path: config.queuePath,
      key: Buffer.from(config.encryptionKey, "base64"),
      maxEvents: config.maxEvents ?? 10000,
    });
  } catch (error) {
    release();
    throw error;
  }
  let timer,
    stopped = false,
    pending,
    delay = intervalMs;
  const tick = async () => {
    try {
      const state = await transport.captureState();
      if (stopped) return;
      if (state.status === "withdrawn") {
        queue.withdraw();
        stopped = true;
        onStatus({ state: "withdrawn" });
        return;
      }
      let upload = { uploaded: 0 };
      const result = await gateway.collectPilotEvidence((binding) => {
        if (
          createHash("sha256").update(binding.owner.actorId).digest("hex") !==
          config.ownerSha256
        )
          throw new NativeHostError("Pilot account binding changed");
        const capture = createPilotTaskCapture({
          ...binding,
          queue,
          participantId: config.participantId,
          deviceId: config.deviceId,
          pseudonymKey: Buffer.from(config.pseudonymKey, "base64"),
          captureState: async () => state,
        });
        return {
          async collect() {
            let result, capacityFailure;
            try {
              result = await capture.collect();
            } catch (error) {
              if (error.code !== "TRACE_QUEUE_FULL") throw error;
              capacityFailure = error;
            }
            if (stopped) return result;
            if (!binding.isCurrentOwner())
              throw new NativeHostError("Pilot task owner changed");
            if (state.status === "active")
              upload = await queue.flush(transport.upload);
            // Keep the failed source cursor for the next tick, after draining
            // already-authorized durable evidence from the full queue.
            if (capacityFailure) throw capacityFailure;
            return result;
          },
        };
      });
      if (stopped) return;
      delay = intervalMs;
      onStatus({
        state: state.status,
        ...result,
        ...upload,
        ...queue.status(),
      });
    } catch {
      delay = Math.min(60000, delay * 2);
      if (!stopped)
        onStatus({ state: "retrying", retryAfterMs: delay, ...queue.status() });
    } finally {
      if (!stopped)
        timer = setTimeout(() => {
          pending = tick();
        }, delay);
    }
  };
  pending = tick();
  let closed = false;
  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      cancellation.abort();
      await pending;
      if (!closed) {
        queue.close();
        release();
        closed = true;
      }
    },
  };
}
