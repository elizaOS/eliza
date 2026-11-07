import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { NativeHostError } from "./errors.mjs";
// Never steal a lease. After a crash an operator must confirm the old process is
// gone before removing its lock; PID reuse makes automatic takeover unsafe.
export function acquireExclusiveDatabaseLease(databasePath) {
  const path = databasePath + ".lock";
  const fd = openSync(path, "wx", 0o600);
  let owned;
  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
    owned = fstatSync(fd);
  } finally {
    closeSync(fd);
  }
  let released = false;
  return () => {
    if (!released) {
      const current = lstatSync(path);
      if (
        !current.isFile() ||
        current.dev !== owned.dev ||
        current.ino !== owned.ino
      )
        throw new NativeHostError("Database lease ownership changed");
      unlinkSync(path);
      released = true;
    }
  };
}
