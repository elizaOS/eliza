/**
 * Hosts a resettable marketplace plus npm-compatible artifact registry over
 * real loopback HTTP. State, faults, virtual time, and observations are bound
 * to a generation so a request admitted before reset cannot mutate or appear
 * in the current synthetic world.
 */
import crypto from "node:crypto";
import { gzipSync } from "node:zlib";
import { startFetchServer } from "../fetch-server.ts";

const PACKAGE_NAME = "@synthetic/plugin-weather";
const PACKAGE_VERSION = "1.0.0";

export type RegistryMockFault =
  | { kind: "status"; status: number; retryAfterSeconds?: number }
  | { kind: "malformed-json" }
  | { kind: "delay"; ms: number }
  | { kind: "stall" }
  | { kind: "redirect"; location?: string }
  | {
      kind: "raw-json-response";
      body: string | number[];
      contentType?: string;
      contentEncoding?: string;
      contentLength?: string;
    }
  | { kind: "integrity-mismatch" }
  | { kind: "corrupt-artifact" };

export interface RegistryMockObservation {
  sequence: number;
  generation: number;
  at: number;
  method: string;
  path: string;
  ifNoneMatch: string | null;
  authorization: "[REDACTED]" | null;
  status: number;
  stale: boolean;
}

export interface RegistryMockReadback {
  generation: number;
  now: number;
  observations: RegistryMockObservation[];
  staleObservations: RegistryMockObservation[];
}

export interface RegistryMockSeed {
  packageName?: string;
  version?: string;
  description?: string;
}

interface NormalizedSeed {
  packageName: string;
  version: string;
  description: string;
}

function normalizeSeed(seed: RegistryMockSeed = {}): NormalizedSeed {
  return {
    packageName: seed.packageName ?? PACKAGE_NAME,
    version: seed.version ?? PACKAGE_VERSION,
    description:
      seed.description ?? "Deterministic synthetic weather connector",
  };
}

function writeOctal(
  buffer: Buffer,
  offset: number,
  length: number,
  value: number,
): void {
  const encoded = value
    .toString(8)
    .padStart(length - 1, "0")
    .slice(-(length - 1));
  buffer.write(`${encoded}\0`, offset, length, "ascii");
}

function tarEntry(name: string, contents: Buffer): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, contents.length);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  const checksumText = checksum.toString(8).padStart(6, "0");
  header.write(`${checksumText}\0 `, 148, 8, "ascii");
  const padding = Buffer.alloc((512 - (contents.length % 512)) % 512);
  return Buffer.concat([header, contents, padding]);
}

function packageArtifact(seed: NormalizedSeed): Buffer {
  const manifest = Buffer.from(
    `${JSON.stringify(
      {
        name: seed.packageName,
        version: seed.version,
        type: "module",
        main: "index.js",
        exports: "./index.js",
      },
      null,
      2,
    )}\n`,
  );
  const source = Buffer.from(
    `export const syntheticRegistryArtifact = ${JSON.stringify(seed.description)};\n`,
  );
  const tar = Buffer.concat([
    tarEntry("package/package.json", manifest),
    tarEntry("package/index.js", source),
    Buffer.alloc(1024),
  ]);
  return gzipSync(tar, { level: 9 });
}

function etag(body: Uint8Array): string {
  return `"sha256-${crypto.createHash("sha256").update(body).digest("hex")}"`;
}

function sri(body: Uint8Array): string {
  return `sha512-${crypto.createHash("sha512").update(body).digest("base64")}`;
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

function stall(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
}

export async function startRegistryMock(seedInput: RegistryMockSeed = {}) {
  let seed = normalizeSeed(seedInput);
  let generation = 1;
  let now = 1_700_000_000_000;
  let sequence = 0;
  let observations: RegistryMockObservation[] = [];
  let staleObservations: RegistryMockObservation[] = [];
  const faults = new Map<string, RegistryMockFault[]>();
  let origin = "";

  const server = await startFetchServer(async (request) => {
    const admittedGeneration = generation;
    const url = new URL(request.url);
    const path = url.pathname;
    const normalizedPath = path.replace(/%2f/gi, "%2f");
    const faultQueue = faults.get(path) ?? faults.get(normalizedPath);
    const fault = faultQueue?.shift();
    const record = (status: number): void => {
      const observation: RegistryMockObservation = {
        sequence: ++sequence,
        generation: admittedGeneration,
        at: now,
        method: request.method,
        path,
        ifNoneMatch: request.headers.get("if-none-match"),
        authorization: request.headers.has("authorization")
          ? "[REDACTED]"
          : null,
        status,
        stale: admittedGeneration !== generation,
      };
      if (observation.stale) staleObservations.push(observation);
      else observations.push(observation);
    };

    if (fault?.kind === "delay") {
      try {
        await abortableDelay(fault.ms, request.signal);
      } catch (error) {
        // error-policy:J2 bind cancellation to an observation, then preserve
        // its cause across the mock HTTP boundary.
        record(499);
        throw new Error("Synthetic delayed request aborted", { cause: error });
      }
      if (admittedGeneration !== generation) {
        record(409);
        return new Response("stale synthetic generation", { status: 409 });
      }
    } else if (fault?.kind === "stall") {
      try {
        await stall(request.signal);
      } catch (error) {
        // error-policy:J2 bind cancellation to an observation, then preserve
        // its cause across the mock HTTP boundary.
        record(499);
        throw new Error("Synthetic stalled request aborted", { cause: error });
      }
    } else if (fault?.kind === "status") {
      record(fault.status);
      return new Response("synthetic status fault", {
        status: fault.status,
        headers:
          fault.retryAfterSeconds === undefined
            ? undefined
            : { "retry-after": String(fault.retryAfterSeconds) },
      });
    } else if (fault?.kind === "malformed-json") {
      record(200);
      return new Response("{not-json", {
        headers: { "content-type": "application/json" },
      });
    } else if (fault?.kind === "redirect") {
      record(302);
      return Response.redirect(
        fault.location ?? `${origin}/redirect-target`,
        302,
      );
    } else if (fault?.kind === "raw-json-response") {
      record(200);
      const headers = new Headers();
      if (fault.contentType !== undefined)
        headers.set("content-type", fault.contentType);
      if (fault.contentEncoding !== undefined)
        headers.set("content-encoding", fault.contentEncoding);
      if (fault.contentLength !== undefined)
        headers.set("content-length", fault.contentLength);
      const body =
        typeof fault.body === "string"
          ? fault.body
          : Uint8Array.from(fault.body);
      return new Response(body, { headers });
    }

    const artifact = packageArtifact(seed);
    const generatedBody = Buffer.from(
      JSON.stringify({
        registry: {
          [seed.packageName]: {
            git: {
              repo: "synthetic/plugin-weather",
              v0: { branch: null },
              v1: { branch: null },
              v2: { branch: "main" },
            },
            npm: {
              repo: seed.packageName,
              v0: null,
              v1: null,
              v2: seed.version,
            },
            supports: { v0: false, v1: false, v2: true },
            directory: null,
            description: seed.description,
            homepage: null,
            topics: ["synthetic", "weather"],
            stargazers_count: 42,
            language: "TypeScript",
            origin: "third-party",
            source: "synthetic",
            support: "community",
            builtIn: false,
            firstParty: false,
            thirdParty: true,
            status: "active",
            registryKind: "plugin",
          },
        },
      }),
    );

    if (path === "/generated-registry.json") {
      const tag = etag(generatedBody);
      if (request.headers.get("if-none-match") === tag) {
        record(304);
        return new Response(null, { status: 304, headers: { etag: tag } });
      }
      record(200);
      return new Response(generatedBody, {
        headers: { "content-type": "application/json", etag: tag },
      });
    }
    if (path === "/index.json") {
      const body = Buffer.from(
        JSON.stringify({
          [seed.packageName]: "github:synthetic/plugin-weather",
        }),
      );
      const tag = etag(body);
      if (request.headers.get("if-none-match") === tag) {
        record(304);
        return new Response(null, { status: 304, headers: { etag: tag } });
      }
      record(200);
      return new Response(body, {
        headers: { "content-type": "application/json", etag: tag },
      });
    }

    const encodedName = seed.packageName.replace("/", "%2f");
    if (
      normalizedPath === `/npm/${encodedName}` ||
      path === `/npm/${seed.packageName}`
    ) {
      const integrity =
        fault?.kind === "integrity-mismatch"
          ? `sha512-${Buffer.alloc(64).toString("base64")}`
          : sri(artifact);
      const tarballName = seed.packageName.split("/").at(-1);
      const body = {
        name: seed.packageName,
        "dist-tags": { latest: seed.version },
        versions: {
          [seed.version]: {
            name: seed.packageName,
            version: seed.version,
            dist: {
              tarball: `${origin}/npm/${encodedName}/-/${tarballName}-${seed.version}.tgz`,
              integrity,
              shasum: crypto.createHash("sha1").update(artifact).digest("hex"),
            },
          },
        },
      };
      record(200);
      return Response.json(body);
    }
    if (
      normalizedPath.endsWith(`-${seed.version}.tgz`) &&
      normalizedPath.startsWith(`/npm/${encodedName}/-/`)
    ) {
      const corruptOffset = Math.min(20, artifact.length - 1);
      const originalByte = artifact.at(corruptOffset);
      if (originalByte === undefined)
        throw new Error("Synthetic artifact is empty");
      const bytes =
        fault?.kind === "corrupt-artifact"
          ? Buffer.concat([
              artifact.subarray(0, corruptOffset),
              Buffer.from([originalByte ^ 0xff]),
              artifact.subarray(corruptOffset + 1),
            ])
          : artifact;
      record(200);
      return new Response(Uint8Array.from(bytes).buffer, {
        headers: { "content-type": "application/octet-stream" },
      });
    }

    record(404);
    return new Response("not found", { status: 404 });
  });

  origin = `http://${server.hostname}:${server.port}`;
  return {
    origin,
    generatedRegistryUrl: `${origin}/generated-registry.json`,
    indexRegistryUrl: `${origin}/index.json`,
    packageRegistryUrl: `${origin}/npm/`,
    enqueueFault(path: string, fault: RegistryMockFault): void {
      const queue = faults.get(path) ?? [];
      queue.push(fault);
      faults.set(path, queue);
    },
    pendingFaultCount(path: string): number {
      return faults.get(path)?.length ?? 0;
    },
    advanceTime(ms: number): void {
      if (!Number.isInteger(ms) || ms < 0)
        throw new Error("advanceTime requires non-negative integer ms");
      now += ms;
    },
    now(): number {
      return now;
    },
    reset(nextSeed: RegistryMockSeed = seedInput): void {
      seed = normalizeSeed(nextSeed);
      generation += 1;
      now = 1_700_000_000_000;
      sequence = 0;
      observations = [];
      staleObservations = [];
      faults.clear();
    },
    readback(): RegistryMockReadback {
      return {
        generation,
        now,
        observations: structuredClone(observations),
        staleObservations: structuredClone(staleObservations),
      };
    },
    stop: server.stop,
  };
}
