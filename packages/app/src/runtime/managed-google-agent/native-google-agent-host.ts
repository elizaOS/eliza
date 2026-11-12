import { timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { dirname } from "node:path";
import {
  createManagedGoogleAgentBroker,
  type ManagedGoogleBrokerDiagnostic,
} from "./managed-google-agent-broker.ts";
import {
  createManagedGoogleAgentHost,
  type GoogleAgentAccess,
  type ManagedGoogleAgentHostOptions,
  type ManagedGoogleAgentPort,
} from "./managed-google-agent-host.ts";
import {
  createNativeGoogleCloudPort,
  type NativeGoogleBinding,
} from "./native-google-cloud-port.ts";

/** The owner's Settings switches from the native application. Read before every
 * agent write so a toggle applies without a restart; no file, or anything but version 1 booleans, is off. */
export function readGoogleAgentAccessFile(file?: string): GoogleAgentAccess {
  const off = { gmailChanges: false, calendarEdits: false };
  if (!file) return off;
  try {
    // Match the writer's private directory and reject special targets without
    // blocking. Read the opened inode so an atomic replacement cannot splice it.
    if (!lstatSync(dirname(file)).isDirectory()) return off;
    const fd = openSync(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      if (!fstatSync(fd).isFile()) return off;
      const saved = JSON.parse(readFileSync(fd, "utf8"));
      if (
        saved?.version !== 1 ||
        typeof saved.gmailChanges !== "boolean" ||
        typeof saved.calendarEdits !== "boolean"
      )
        return off;
      return {
        gmailChanges: saved.gmailChanges,
        calendarEdits: saved.calendarEdits,
      };
    } finally {
      closeSync(fd);
    }
  } catch {
    return off;
  }
}

/** Signed in-process application host; no renderer, browser profile or credential writes. */
export async function startNativeGoogleAgentHost(
  options: ManagedGoogleAgentHostOptions & {
    binding: NativeGoogleBinding;
    apiToken: string;
    userAgent: string;
    request?: typeof fetch;
    assertCurrent?: () => void;
  },
) {
  if (!/^[A-Za-z0-9_-]{64}$/.test(options.apiToken))
    throw Error("Private native agent authentication is unavailable");
  const retired = new AbortController();
  const port = createNativeGoogleCloudPort(options.binding, {
    apiOrigin: options.apiOrigin,
    userAgent: options.userAgent,
    request: options.request,
    assertCurrent: () => {
      retired.signal.throwIfAborted();
      options.assertCurrent?.();
    },
  });
  const host = await startManagedGoogleAgentHost({
    port,
    apiToken: options.apiToken,
    access: options.access,
    apiOrigin: options.apiOrigin,
    calendarReadTiming: options.calendarReadTiming,
    gmailReadBodyMaxCharacters: options.gmailReadBodyMaxCharacters,
  });
  return {
    port: host.port,
    async close() {
      if (!retired.signal.aborted) retired.abort();
      await host.close();
    },
  };
}

/** Same private broker lifecycle for an existing host-owned Cloud port. */
export async function startManagedGoogleAgentHost(
  options: ManagedGoogleAgentHostOptions & {
    port: ManagedGoogleAgentPort;
    apiToken: string;
    diagnostic?: (value: ManagedGoogleBrokerDiagnostic) => void;
  },
) {
  if (!/^[A-Za-z0-9_-]{64}$/.test(options.apiToken))
    throw Error("Private agent authentication is unavailable");
  const broker = createManagedGoogleAgentBroker({
    host: createManagedGoogleAgentHost(options.port, options),
    diagnostic: options.diagnostic,
    async authorized(value) {
      const actual = Buffer.from(value ?? ""),
        expected = Buffer.from(`Bearer ${options.apiToken}`);
      return (
        actual.length === expected.length && timingSafeEqual(actual, expected)
      );
    },
  });
  const server = createServer(
    { maxHeaderSize: 8192 },
    (req, res) => void broker(req, res),
  );
  server.requestTimeout = 35000;
  server.headersTimeout = 5000;
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= new Promise<void>((resolve, reject) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    }));
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw Error("Private Google host did not bind");
    return { port: address.port, close };
  } catch (error) {
    await close();
    throw error;
  }
}
