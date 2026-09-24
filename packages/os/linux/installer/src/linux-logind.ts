import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ActiveOwnerSession } from "./root-service";
import type {
  KernelBoundPeerProcessHandle,
  LogindSessionResolver,
} from "./unix-transport";

const execFileAsync = promisify(execFile);
const BUSCTL = "/usr/bin/busctl";
const LOGIN1 = "org.freedesktop.login1";
const MANAGER_PATH = "/org/freedesktop/login1";
const MANAGER_INTERFACE = "org.freedesktop.login1.Manager";
const PROPERTIES_INTERFACE = "org.freedesktop.DBus.Properties";
const SESSION_INTERFACE = "org.freedesktop.login1.Session";
const MAX_BUSCTL_OUTPUT_BYTES = 16 * 1024;

export interface LogindCommandRunner {
  run(argv: readonly string[]): Promise<string>;
}

export interface SystemdLogindSessionResolverOptions {
  /** Map an OS uid to the identifier issued by the owner credential verifier. */
  ownerIdForUid(uid: number): string;
  runner?: LogindCommandRunner;
}

interface BusctlVariant {
  type: unknown;
  data: unknown;
}

interface LogindSessionSnapshot {
  sessionId: string;
  uid: number;
  active: boolean;
  locked: boolean;
  remote: boolean;
  seatId: string;
  sessionClass: string;
  state: string;
}

class BusctlCommandRunner implements LogindCommandRunner {
  async run(argv: readonly string[]): Promise<string> {
    const { stdout } = await execFileAsync(BUSCTL, [...argv], {
      encoding: "utf8",
      env: {
        LANG: "C",
        LC_ALL: "C",
        PATH: "/usr/bin:/bin",
      },
      maxBuffer: MAX_BUSCTL_OUTPUT_BYTES,
      timeout: 5_000,
      windowsHide: true,
    });
    if (Buffer.byteLength(stdout, "utf8") > MAX_BUSCTL_OUTPUT_BYTES) {
      throw new Error("logind response exceeds its bounded output size.");
    }
    return stdout.trim();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === keys.length && actual.every((key, i) => key === keys[i])
  );
}

function parseObjectPath(output: string): string {
  const match =
    /^o "(\/org\/freedesktop\/login1\/session\/[A-Za-z0-9_]+)"$/.exec(output);
  if (!match) {
    throw new Error("logind returned an invalid session object path.");
  }
  return match[1];
}

function variant(
  properties: Record<string, unknown>,
  name: string,
  type: string,
): unknown {
  const value = properties[name];
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["data", "type"]) ||
    value.type !== type
  ) {
    throw new Error(`logind returned an invalid ${name} property.`);
  }
  return (value as unknown as BusctlVariant).data;
}

function stringVariant(
  properties: Record<string, unknown>,
  name: string,
): string {
  const value = variant(properties, name, "s");
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:@-]{1,256}$/.test(value)) {
    throw new Error(`logind returned an invalid ${name} property.`);
  }
  return value;
}

function booleanVariant(
  properties: Record<string, unknown>,
  name: string,
): boolean {
  const value = variant(properties, name, "b");
  if (typeof value !== "boolean") {
    throw new Error(`logind returned an invalid ${name} property.`);
  }
  return value;
}

function userVariant(properties: Record<string, unknown>): number {
  const value = variant(properties, "User", "(uo)");
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error("logind returned an invalid User property.");
  }
  const [uid, path] = value;
  if (
    !Number.isSafeInteger(uid) ||
    (uid as number) < 0 ||
    typeof path !== "string" ||
    path !== `/org/freedesktop/login1/user/_${uid as number}`
  ) {
    throw new Error("logind returned an invalid User property.");
  }
  return uid as number;
}

function seatVariant(properties: Record<string, unknown>): string {
  const value = variant(properties, "Seat", "(so)");
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error("logind returned an invalid Seat property.");
  }
  const [seatId, path] = value;
  if (
    typeof seatId !== "string" ||
    !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(seatId) ||
    typeof path !== "string" ||
    path !== `/org/freedesktop/login1/seat/${seatId}`
  ) {
    throw new Error("logind returned an invalid Seat property.");
  }
  return seatId;
}

function parseSessionSnapshot(output: string): LogindSessionSnapshot {
  let document: unknown;
  try {
    document = JSON.parse(output);
  } catch {
    throw new Error("logind returned malformed session property JSON.");
  }
  if (
    !isRecord(document) ||
    !hasExactKeys(document, ["data", "type"]) ||
    document.type !== "a{sv}" ||
    !isRecord(document.data)
  ) {
    throw new Error("logind returned an invalid session property snapshot.");
  }
  const properties = document.data;
  return {
    sessionId: stringVariant(properties, "Id"),
    uid: userVariant(properties),
    active: booleanVariant(properties, "Active"),
    locked: booleanVariant(properties, "LockedHint"),
    remote: booleanVariant(properties, "Remote"),
    seatId: seatVariant(properties),
    sessionClass: stringVariant(properties, "Class"),
    state: stringVariant(properties, "State"),
  };
}

export class SystemdLogindSessionResolver implements LogindSessionResolver {
  readonly ownerIdForUid: (uid: number) => string;
  readonly runner: LogindCommandRunner;

  constructor(options: SystemdLogindSessionResolverOptions) {
    this.ownerIdForUid = options.ownerIdForUid;
    this.runner = options.runner ?? new BusctlCommandRunner();
  }

  private async checkedLookup(
    process: KernelBoundPeerProcessHandle,
    argv: readonly string[],
  ): Promise<string> {
    if (!(await process.isAlive())) {
      throw new Error("Installer peer exited before the logind lookup.");
    }
    const output = await this.runner.run(argv);
    if (!(await process.isAlive())) {
      throw new Error("Installer peer exited during the logind lookup.");
    }
    return output;
  }

  private async sessionPath(
    process: KernelBoundPeerProcessHandle,
  ): Promise<string> {
    return parseObjectPath(
      await this.checkedLookup(process, [
        "--system",
        "--no-pager",
        "--no-legend",
        "--auto-start=no",
        "--allow-interactive-authorization=no",
        "call",
        LOGIN1,
        MANAGER_PATH,
        MANAGER_INTERFACE,
        "GetSessionByPID",
        "u",
        String(process.pid),
      ]),
    );
  }

  async inspectForProcess(
    process: KernelBoundPeerProcessHandle,
    expectedUid: number,
  ): Promise<ActiveOwnerSession | null> {
    try {
      const path = await this.sessionPath(process);
      const snapshot = parseSessionSnapshot(
        await this.checkedLookup(process, [
          "--system",
          "--no-pager",
          "--no-legend",
          "--json=short",
          "--auto-start=no",
          "--allow-interactive-authorization=no",
          "call",
          LOGIN1,
          path,
          PROPERTIES_INTERFACE,
          "GetAll",
          "s",
          SESSION_INTERFACE,
        ]),
      );
      if (
        snapshot.uid !== expectedUid ||
        !snapshot.active ||
        snapshot.locked ||
        snapshot.remote ||
        !snapshot.seatId ||
        snapshot.sessionClass !== "user" ||
        snapshot.state !== "active"
      ) {
        return null;
      }
      if ((await this.sessionPath(process)) !== path) {
        return null;
      }
      const ownerId = this.ownerIdForUid(snapshot.uid);
      if (
        typeof ownerId !== "string" ||
        !ownerId.trim() ||
        ownerId.includes("\0") ||
        Buffer.byteLength(ownerId, "utf8") > 256
      ) {
        throw new Error(
          "Owner credential mapping returned an invalid owner id.",
        );
      }
      return {
        ownerId,
        uid: snapshot.uid,
        sessionId: snapshot.sessionId,
        active: snapshot.active,
        locked: snapshot.locked,
      };
    } catch {
      return null;
    }
  }
}
