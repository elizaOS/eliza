// spec/core/media.md, "Transport host spelling preserves DNS and IP certificate semantics"; spec/core/media.md, "Fetching requires a screened endpoint and finishing requires complete bounded bytes"
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { type AddressInfo, isIP, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import tls, { type TLSSocket } from "node:tls";
import { promisify } from "node:util";
import type { LookupAddress, LookupFn } from "@elizaos/core";

export type Handler = (request: IncomingMessage, response: ServerResponse) => void;

export interface Recorded {
  method: string;
  path: string;
  host: string | null;
  serverName: string | null;
  closed: boolean;
}

export interface Loopback {
  readonly port: number;
  readonly requests: Recorded[];
  url(host: string, pathname?: string): string;
  socketClosed(index: number): Promise<void>;
  close(): Promise<void>;
}

export interface LoopbackTls extends Loopback {
  readonly certificate: string;
}

export interface Certificate {
  key: string;
  cert: string;
}

export type Lookup = LookupFn & { readonly queries: string[] };

export interface PinnedLookupOptions {
  flipAfter?: number;
  flipTo?: string;
  never?: boolean;
}

const run = promisify(execFile);

const certificateConfig = [
  "[req]",
  "distinguished_name = name",
  "x509_extensions = leaf",
  "prompt = no",
  "[name]",
  "CN = localhost",
  "[leaf]",
  "basicConstraints = critical, CA:TRUE",
  "keyUsage = critical, digitalSignature, keyEncipherment, keyCertSign",
  "extendedKeyUsage = serverAuth",
  "subjectAltName = DNS:localhost, IP:127.0.0.1, IP:::1",
  "",
].join("\n");

let certificate: Promise<Certificate> | undefined;

async function makeCertificate(): Promise<Certificate> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "core-loopback-cert-"));
  try {
    const config = path.join(directory, "openssl.cnf");
    const keyFile = path.join(directory, "key.pem");
    const certFile = path.join(directory, "cert.pem");
    await writeFile(config, certificateConfig);
    await run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "2", "-config", config, "-keyout", keyFile, "-out", certFile]);
    return { key: await readFile(keyFile, "utf8"), cert: await readFile(certFile, "utf8") };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function loopbackCertificate(): Promise<Certificate> {
  certificate ??= makeCertificate();
  return certificate;
}

let trustedServers = 0;
let defaultAuthorities: string[] = [];

function trust(cert: string): void {
  if (trustedServers === 0) {
    defaultAuthorities = tls.getCACertificates("default");
    tls.setDefaultCACertificates([...defaultAuthorities, cert]);
  }
  trustedServers += 1;
}

function untrust(): void {
  trustedServers -= 1;
  if (trustedServers === 0) tls.setDefaultCACertificates(defaultAuthorities);
}

function listen(server: Server, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function shut(server: Server, sockets: ReadonlySet<Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function addressInUse(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "EADDRINUSE";
}

function track(server: Server, sockets: Set<Socket>): Server {
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  return server;
}

async function listenOnBothLoopbacks(make: () => Server, sockets: Set<Socket>): Promise<{ servers: Server[]; port: number }> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const ipv4 = track(make(), sockets);
    const port = await listen(ipv4, "127.0.0.1", 0);
    const ipv6 = track(make(), sockets);
    try {
      await listen(ipv6, "::1", port);
      return { servers: [ipv4, ipv6], port };
    } catch (error) {
      await shut(ipv4, sockets);
      if (!addressInUse(error)) throw error;
    }
  }
  throw new Error("loopback: no port is free on both 127.0.0.1 and ::1");
}

function serverNameOf(request: IncomingMessage): string | null {
  const name = (request.socket as Partial<TLSSocket>).servername;
  return typeof name === "string" ? name : null;
}

async function start(scheme: "http" | "https", make: (listener: Handler) => Server, handler: Handler): Promise<Loopback> {
  const requests: Recorded[] = [];
  const closings: Promise<void>[] = [];
  const listener: Handler = (request, response) => {
    const record: Recorded = {
      method: request.method ?? "",
      path: request.url ?? "",
      host: request.headers.host ?? null,
      serverName: serverNameOf(request),
      closed: false,
    };
    requests.push(record);
    closings.push(
      new Promise((resolve) => {
        request.socket.once("close", () => {
          record.closed = true;
          resolve();
        });
      }),
    );
    handler(request, response);
  };
  const sockets = new Set<Socket>();
  const { servers, port } = await listenOnBothLoopbacks(() => make(listener), sockets);
  return {
    port,
    requests,
    url: (host, pathname = "/") => `${scheme}://${host}:${port}${pathname}`,
    socketClosed: (index) => closings[index] ?? Promise.reject(new Error(`loopback: no request ${index}`)),
    close: async () => {
      await Promise.all(servers.map((server) => shut(server, sockets)));
    },
  };
}

export function loopback(handler: Handler): Promise<Loopback> {
  return start("http", (listener) => createHttpServer(listener), handler);
}

export async function loopbackTls(handler: Handler): Promise<LoopbackTls> {
  const { key, cert } = await loopbackCertificate();
  const server = await start("https", (listener) => createHttpsServer({ key, cert }, listener), handler);
  trust(cert);
  return {
    ...server,
    certificate: cert,
    close: async () => {
      await server.close();
      untrust();
    },
  };
}

function notFound(hostname: string): Error {
  return Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND", hostname });
}

export function pinnedLookup(map: Readonly<Record<string, string>>, options: PinnedLookupOptions = {}): Lookup {
  const queries: string[] = [];
  const lookup = (hostname: string): Promise<LookupAddress[]> => {
    queries.push(hostname);
    if (options.never) return new Promise<LookupAddress[]>(() => undefined);
    const flipped = options.flipAfter !== undefined && queries.length > options.flipAfter;
    const address = flipped ? (options.flipTo ?? "10.0.0.1") : Object.hasOwn(map, hostname) ? map[hostname] : undefined;
    if (address === undefined) return Promise.reject(notFound(hostname));
    return Promise.resolve([{ address, family: isIP(address) }]);
  };
  return Object.assign(lookup, { queries });
}
