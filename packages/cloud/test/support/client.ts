// spec/cloud/client.md, "Story: Use the cloud from the device as configured"
export type BundleGraph = {
  readonly missing: ReadonlyArray<string>;
  readonly serverFiles: ReadonlyArray<string>;
  readonly forbidden: ReadonlyArray<string>;
};

export type RecordingFetch = {
  readonly fetch: typeof fetch;
  readonly authorizations: ReadonlyArray<string | null>;
};

type Glob = (patterns: ReadonlyArray<string>, options: { readonly query: string; readonly import: string; readonly eager: true }) => Record<string, string>;

const importPattern = /(?:^|[\s;}])(?:import|export)\s[^"';]*?from\s*["']([^"']+)["']|(?:^|[\s;])import\s*(?:\(\s*)?["']([^"']+)["']/gm;

function resolved(from: string, specifier: string): string {
  const parts = from.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "..") parts.pop();
    else if (part !== ".") parts.push(part);
  }
  return parts.join("/");
}

export function clientBundleGraph(): BundleGraph {
  const sources = (import.meta as ImportMeta & { readonly glob: Glob }).glob(["../../src/**/*.{vibe,ts}", "../../gen/*.{vibe,ts}"], { query: "?raw", import: "default", eager: true });
  const files = new Set<string>();
  const packages = new Set<string>();
  const pending = ["../../src/client/index.vibe"];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (files.has(file)) continue;
    files.add(file);
    for (const found of (sources[file] ?? "").matchAll(importPattern)) {
      const specifier = found[1] ?? found[2] ?? "";
      if (specifier.startsWith(".")) pending.push(resolved(file, specifier));
      else packages.add(specifier);
    }
  }
  const sorted = [...files].sort();
  return {
    missing: sorted.filter((file) => sources[file] === undefined),
    serverFiles: sorted.filter((file) => /^\.\.\/\.\.\/src\/(http|store)\//.test(file)),
    forbidden: [...packages].sort().filter((name) => !/^(effect|vibelang-runtime)(\/|$)/.test(name)),
  };
}

export function runsInBrowser(): boolean {
  return typeof window === "object" && typeof document === "object";
}

export const networkFetch: typeof fetch = (input, init) => fetch(input, init);

export function recordingFetch(answer: unknown): RecordingFetch {
  const authorizations: Array<string | null> = [];
  return {
    authorizations,
    fetch: (input, init) => new Promise((resolve) => {
      authorizations.push(new Request(input, init).headers.get("authorization"));
      resolve(Response.json(answer));
    }),
  };
}
