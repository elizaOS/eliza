import { closeSync, openSync, unlinkSync, writeSync } from "node:fs";
// Never steal a lease. After a crash an operator must confirm the old process is
// gone before removing its lock; PID reuse makes automatic takeover unsafe.
export function acquireExclusiveDatabaseLease(databasePath) {
  const path = databasePath + ".lock";
  const fd = openSync(path, "wx", 0o600);
  writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
  closeSync(fd);
  let released = false;
  return () => {
    if (!released) {
      unlinkSync(path);
      released = true;
    }
  };
}
