/** Proves the production pinned-Bun preload guard blocks forbidden child egress. */

import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("production Bun preload blocks a child fetch before external egress", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cloud-network-guard-"));
  try {
    const ledger = path.join(directory, "ledger.jsonl");
    const guard = path.resolve(
      import.meta.dirname,
      "../../scripts/stability-network-guard.mjs",
    );
    const child = Bun.spawn(
      [
        process.execPath,
        "--preload",
        guard,
        "-e",
        'await fetch("https://example.com/forbidden")',
      ],
      {
        cwd: directory,
        env: {
          PATH: process.env.PATH,
          ELIZA_STABILITY_CHILD_NETWORK_LEDGER: ledger,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(await child.exited).not.toBe(0);
    const stderr = await new Response(child.stderr).text();
    expect(stderr).toContain(
      "stability network policy blocked https://example.com",
    );
    const entry = JSON.parse((await readFile(ledger, "utf8")).trim()) as {
      at: string;
      origin: string;
      method: string;
      allowed: boolean;
    };
    expect(entry).toEqual({
      at: expect.any(String),
      origin: "https://example.com",
      method: "GET",
      allowed: false,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("production Bun preload rejects a DNS name with a loopback-looking prefix", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cloud-network-guard-"));
  try {
    const ledger = path.join(directory, "ledger.jsonl");
    const guard = path.resolve(
      import.meta.dirname,
      "../../scripts/stability-network-guard.mjs",
    );
    const child = Bun.spawn(
      [
        process.execPath,
        "--preload",
        guard,
        "-e",
        'await fetch("http://127.attacker.invalid/forbidden")',
      ],
      {
        cwd: directory,
        env: {
          PATH: process.env.PATH,
          ELIZA_STABILITY_CHILD_NETWORK_LEDGER: ledger,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(await child.exited).not.toBe(0);
    expect(await new Response(child.stderr).text()).toContain(
      "stability network policy blocked http://127.attacker.invalid",
    );
    expect(JSON.parse((await readFile(ledger, "utf8")).trim())).toMatchObject({
      origin: "http://127.attacker.invalid",
      allowed: false,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("production Bun preload rejects a loopback fetch redirect before the target", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cloud-network-guard-"));
  let targetCalls = 0;
  const target = Bun.serve({
    hostname: "0.0.0.0",
    port: 0,
    fetch() {
      targetCalls += 1;
      return Response.json({ reached: true });
    },
  });
  const redirect = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return Response.redirect(`http://0.0.0.0:${target.port}/target`, 302);
    },
  });
  try {
    const ledger = path.join(directory, "ledger.jsonl");
    const guard = path.resolve(
      import.meta.dirname,
      "../../scripts/stability-network-guard.mjs",
    );
    const child = Bun.spawn(
      [
        process.execPath,
        "--preload",
        guard,
        "-e",
        `await fetch("http://127.0.0.1:${redirect.port}/redirect")`,
      ],
      {
        cwd: directory,
        env: {
          PATH: process.env.PATH,
          ELIZA_STABILITY_CHILD_NETWORK_LEDGER: ledger,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(await child.exited).not.toBe(0);
    expect(targetCalls).toBe(0);
    const entries = (await readFile(ledger, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(entries).toEqual([
      expect.objectContaining({
        origin: `http://127.0.0.1:${redirect.port}`,
        allowed: true,
      }),
      expect.objectContaining({
        origin: `http://0.0.0.0:${target.port}`,
        allowed: false,
      }),
    ]);
  } finally {
    redirect.stop(true);
    target.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});

test.each([
  {
    name: "node:http.get",
    script: (port: number) =>
      `const http = await import("node:http"); http.get("http://0.0.0.0:${port}/target")`,
    expectedOrigin: (port: number) => `http://0.0.0.0:${port}`,
  },
  {
    name: "node:https.request",
    script: () =>
      'const https = await import("node:https"); https.request("https://example.com/target").end()',
    expectedOrigin: () => "https://example.com",
  },
])(
  "production Bun preload blocks $name alternate transport",
  async ({ script, expectedOrigin }) => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "cloud-network-guard-"),
    );
    let targetCalls = 0;
    const target = Bun.serve({
      hostname: "0.0.0.0",
      port: 0,
      fetch() {
        targetCalls += 1;
        return Response.json({ reached: true });
      },
    });
    try {
      const ledger = path.join(directory, "ledger.jsonl");
      const guard = path.resolve(
        import.meta.dirname,
        "../../scripts/stability-network-guard.mjs",
      );
      const child = Bun.spawn(
        [process.execPath, "--preload", guard, "-e", script(target.port)],
        {
          cwd: directory,
          env: {
            PATH: process.env.PATH,
            ELIZA_STABILITY_CHILD_NETWORK_LEDGER: ledger,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(await child.exited).not.toBe(0);
      expect(targetCalls).toBe(0);
      expect(JSON.parse((await readFile(ledger, "utf8")).trim())).toMatchObject(
        {
          origin: expectedOrigin(target.port),
          allowed: false,
        },
      );
    } finally {
      target.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  },
);
