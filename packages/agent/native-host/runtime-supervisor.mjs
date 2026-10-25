/** Serialize account transitions. Only the process returned by start is ever stopped. */
export function createRuntimeSupervisor({
  readIdentity,
  start,
  stop,
  onError = () => {},
  retryMs = 5000,
  now = Date.now,
}) {
  let running = null,
    identity = null,
    busy = false,
    closed = false,
    retryAt = 0;
  return {
    async reconcile() {
      if (busy || closed) return;
      busy = true;
      try {
        const desired = await readIdentity();
        if (
          running &&
          (desired !== identity ||
            running.exitCode !== null ||
            running.signalCode ||
            running.failed)
        ) {
          const changed = desired !== identity;
          await stop(running);
          running = null;
          identity = null;
          retryAt = changed ? 0 : now() + retryMs;
        }
        if (desired !== null && !running && now() >= retryAt) {
          identity = desired;
          running = await start(desired);
          // Login can change while a process is being spawned. Fence it immediately.
          if (closed || (await readIdentity()) !== desired) {
            await stop(running);
            running = null;
            identity = null;
          }
        }
      } catch (error) {
        retryAt = now() + retryMs;
        onError(error);
      } finally {
        busy = false;
      }
    },
    async close() {
      closed = true;
      while (busy) await new Promise((r) => setTimeout(r, 10));
      if (running) {
        await stop(running);
        running = null;
      }
    },
  };
}
