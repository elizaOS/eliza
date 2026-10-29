import fs from "node:fs";
import path from "node:path";
import type { DatabaseLockSnapshot } from "./database-snapshot";

export interface DatabaseStartupLockRecord {
	pid: number;
	createdAt: string;
}

export interface DatabaseStartupLock {
	path: string;
	snapshot: DatabaseLockSnapshot;
	release(): void;
}

export interface DatabaseLockOptions {
	now?: () => Date;
	isProcessAlive?: (pid: number) => boolean;
	staleAfterMs?: number;
}

export type DatabaseLockAcquireResult =
	| { ok: true; lock: DatabaseStartupLock }
	| { ok: false; snapshot: DatabaseLockSnapshot; error: string };

const DEFAULT_STALE_AFTER_MS = 10 * 60 * 1000;
/** pid_t is signed 32-bit: anything outside that range cannot name a live process. */
const MAX_PID = 2_147_483_647;

export function databaseStartupLockPath(pgliteDataDir: string): string {
	return `${pgliteDataDir}.startup.lock`;
}

function defaultIsProcessAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0 || pid > MAX_PID) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// error-policy:J3 signal 0 is a liveness probe, not a kill: ESRCH means the
		// owner is gone, but EPERM means it is alive under another user and only
		// signal delivery was denied. Reading EPERM as "dead" marked a live lock
		// stale, so acquireDatabaseStartupLock deleted it and opened a second
		// writer on the same PGlite data dir. A code the probe cannot explain does
		// not prove the owner is gone, so the lock stays held and the age window
		// still recovers it.
		return (error as NodeJS.ErrnoException | undefined)?.code !== "ESRCH";
	}
}

function readLockRecord(lockPath: string): DatabaseStartupLockRecord | null {
	try {
		const parsed = JSON.parse(fs.readFileSync(lockPath, "utf8")) as {
			pid?: number;
			createdAt?: string;
		};
		if (
			typeof parsed.pid !== "number" ||
			typeof parsed.createdAt !== "string"
		) {
			return null;
		}
		return {
			pid: parsed.pid,
			createdAt: parsed.createdAt,
		};
	} catch {
		return null;
	}
}

export function inspectDatabaseStartupLock(
	lockPath: string,
	options: DatabaseLockOptions = {},
): DatabaseLockSnapshot {
	if (!fs.existsSync(lockPath)) return { held: false };
	const record = readLockRecord(lockPath);
	if (!record) return { held: true, stale: true };
	const now = options.now ?? (() => new Date());
	const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
	const ageMs = now().getTime() - new Date(record.createdAt).getTime();
	const processAlive = (options.isProcessAlive ?? defaultIsProcessAlive)(
		record.pid,
	);
	return {
		held: processAlive,
		stale: !processAlive || ageMs > staleAfterMs,
		ownerPid: record.pid,
	};
}

function writeLock(lockPath: string, now: () => Date): void {
	fs.mkdirSync(path.dirname(lockPath), { recursive: true });
	const record: DatabaseStartupLockRecord = {
		pid: process.pid,
		createdAt: now().toISOString(),
	};
	fs.writeFileSync(lockPath, `${JSON.stringify(record, null, 2)}\n`, {
		encoding: "utf8",
		flag: "wx",
	});
}

export function acquireDatabaseStartupLock(
	pgliteDataDir: string,
	options: DatabaseLockOptions = {},
): DatabaseLockAcquireResult {
	const lockPath = databaseStartupLockPath(pgliteDataDir);
	const now = options.now ?? (() => new Date());
	try {
		writeLock(lockPath, now);
	} catch {
		const snapshot = inspectDatabaseStartupLock(lockPath, options);
		if (!snapshot.stale) {
			return {
				ok: false,
				snapshot,
				error: `PGlite startup lock is held at ${lockPath}.`,
			};
		}
		try {
			fs.rmSync(lockPath, { force: true });
			writeLock(lockPath, now);
		} catch (error) {
			return {
				ok: false,
				snapshot: inspectDatabaseStartupLock(lockPath, options),
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	let released = false;
	return {
		ok: true,
		lock: {
			path: lockPath,
			snapshot: { held: true, ownerPid: process.pid, stale: false },
			release() {
				if (released) return;
				released = true;
				try {
					fs.rmSync(lockPath, { force: true });
				} catch {
					return;
				}
			},
		},
	};
}
