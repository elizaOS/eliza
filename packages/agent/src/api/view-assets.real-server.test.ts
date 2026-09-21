/** Exercises actual view HTTP/file publication, authorization and installation replacement. */
import { execFileSync } from "node:child_process";
import { constants, promises as fs } from "node:fs";
import { stat, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createViewAssetHost as fixture } from "../../test/support/view-assets-host.ts";
import { registerPluginViews } from "./views-registry.ts";

it("binds HEAD and 304 to authorized current bytes and excludes unrelated files", async () => {
  const host = await fixture();
  try {
    const css = new URL("styles/main.css", host.url());
    const initial = await fetch(css);
    expect(initial.status).toBe(200);
    const text = await initial.text();
    const etag = initial.headers.get("etag")!;
    const head = await fetch(css, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("etag")).toBe(etag);
    expect(head.headers.get("content-length")).toBe(
      String(Buffer.byteLength(text)),
    );
    expect(await head.text()).toBe("");
    expect(
      (await fetch(css, { headers: { "If-None-Match": etag } })).status,
    ).toBe(304);
    expect(
      (
        await fetch(css, {
          headers: { "If-None-Match": etag, "x-denied": "1" },
        })
      ).status,
    ).toBe(403);
    expect((await fetch(new URL("unpublished.d.ts", host.url()))).status).toBe(
      404,
    );
    const before = await stat(path.join(host.dir, "styles/main.css"));
    await writeFile(
      path.join(host.dir, "styles/main.css"),
      text.replace("11, 22, 33", "44, 55, 66"),
    );
    await utimes(
      path.join(host.dir, "styles/main.css"),
      before.atime,
      before.mtime,
    );
    for (const method of ["GET", "HEAD"])
      expect(
        (await fetch(css, { method, headers: { "If-None-Match": etag } }))
          .status,
      ).toBe(409);
    await registerPluginViews(host.runtime, host.plugin, {
      pluginDir: host.dir,
    });
    expect(
      (await fetch(css, { headers: { "If-None-Match": etag } })).status,
    ).toBe(409);
    expect((await fetch(new URL("styles/main.css", host.url()))).status).toBe(
      200,
    );
  } finally {
    await host.close();
  }
});

it("rejects manifest traversal and symlink publication before replacing an installation", async () => {
  const host = await fixture();
  const original = host.url().href;
  try {
    await writeFile(
      path.join(host.dir, "frame.html.assets.json"),
      JSON.stringify({ version: 1, files: ["../outside"] }),
    );
    await expect(
      registerPluginViews(host.runtime, host.plugin, { pluginDir: host.dir }),
    ).rejects.toThrow();
    expect(host.url().href).toBe(original);
    await symlink(path.dirname(host.dir), path.join(host.dir, "outside"));
    await writeFile(
      path.join(host.dir, "frame.html.assets.json"),
      JSON.stringify({ version: 1, files: ["outside/anything"] }),
    );
    await expect(
      registerPluginViews(host.runtime, host.plugin, { pluginDir: host.dir }),
    ).rejects.toThrow();
    expect((await fetch(original)).status).toBe(200);
  } finally {
    await host.close();
  }
});

it("rejects a retired installation after its actual file open completes", async () => {
  const host = await fixture();
  const originalOpen = fs.open.bind(fs);
  const pendingPath = await fs.realpath(path.join(host.dir, "styles/main.css"));
  let entered!: () => void;
  let release!: () => void;
  const reading = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = false;
  const read = vi
    .spyOn(fs, "open")
    .mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (!held && String(args[0]) === pendingPath) {
        held = true;
        entered();
        await paused;
      }
      return handle;
    });
  let request: Promise<Response> | undefined;
  try {
    request = fetch(new URL("styles/main.css", host.url()));
    await Promise.race([
      reading,
      request.then(() => {
        throw new Error(
          "Asset request completed without reaching the pending read",
        );
      }),
    ]);
    await registerPluginViews(host.runtime, host.plugin, {
      pluginDir: host.dir,
    });
    release();
    expect((await request).status).toBe(409);
  } finally {
    release();
    await request?.catch(() => undefined);
    read.mockRestore();
    await host.close();
  }
});

it.skipIf(process.platform === "win32")(
  "rejects a published regular file replaced by a FIFO without blocking",
  async () => {
    const host = await fixture();
    const file = path.join(host.dir, "styles/main.css");
    let request: Promise<Response> | undefined;
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 2000);
    try {
      await fs.unlink(file);
      execFileSync("mkfifo", [file]);
      request = fetch(new URL("styles/main.css", host.url()), {
        signal: controller.signal,
      });
      const response = await request;
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: "VIEW_ASSET_CHANGED",
      });
    } finally {
      clearTimeout(deadline);
      await releaseFifoReader(file);
      if (request) await Promise.allSettled([request]);
      await host.close();
    }
  },
);

async function releaseFifoReader(file: string): Promise<void> {
  // Release a blocked reader even when the negative control times out.
  try {
    const writer = await fs.open(
      file,
      constants.O_WRONLY | constants.O_NONBLOCK,
    );
    await writer.close();
  } catch (error) {
    // error-policy:J6 ENXIO means no blocked FIFO reader needs teardown.
    if ((error as NodeJS.ErrnoException).code !== "ENXIO") throw error;
  }
}

it("keeps hero images role-gated and private while allowing authorized mobile clients", async () => {
  const host = await fixture();
  const hero = new URL("/api/views/graph/hero", host.origin);
  try {
    for (const diskImage of [false, true]) {
      if (diskImage) {
        await fs.mkdir(path.join(host.dir, "assets"));
        await writeFile(
          path.join(host.dir, "assets/hero.svg"),
          '<svg xmlns="http://www.w3.org/2000/svg"><text>Private hero</text></svg>',
        );
      }
      const denied = await fetch(hero, { headers: { "x-denied": "1" } });
      expect(denied.status).toBe(403);
      for (const platform of ["ios", "android"]) {
        const allowed = await fetch(hero, {
          headers: { "x-eliza-platform": platform },
        });
        expect(allowed.status).toBe(200);
        expect(allowed.headers.get("cache-control")).toContain("private");
        const etag = allowed.headers.get("etag");
        if (etag)
          expect(
            (
              await fetch(hero, {
                headers: { "x-denied": "1", "if-none-match": etag },
              })
            ).status,
          ).toBe(403);
      }
    }
  } finally {
    await host.close();
  }
});

it("rejects a hero request retired during its file read", async () => {
  const host = await fixture();
  await fs.mkdir(path.join(host.dir, "assets"));
  const file = path.join(host.dir, "assets/hero.svg");
  await writeFile(file, '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const heroPath = await fs.realpath(file);
  const originalRead = fs.readFile.bind(fs);
  let entered!: () => void;
  let release!: () => void;
  const reading = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  const read = vi
    .spyOn(fs, "readFile")
    .mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
      const data = await originalRead(...args);
      if (String(args[0]) === heroPath) {
        entered();
        await paused;
      }
      return data;
    });
  let request: Promise<Response> | undefined;
  try {
    request = fetch(new URL("/api/views/graph/hero", host.origin));
    await Promise.race([
      reading,
      request.then(() => {
        throw new Error("Hero request did not reach file read");
      }),
    ]);
    await registerPluginViews(host.runtime, host.plugin, {
      pluginDir: host.dir,
    });
    release();
    expect((await request).status).toBe(409);
  } finally {
    release();
    await request?.catch(() => undefined);
    read.mockRestore();
    await host.close();
  }
});

it.each([
  ["ENOENT", 200],
  ["EACCES", 500],
])(
  "only uses a generated hero for an expected missing file (%s)",
  async (code, status) => {
    const host = await fixture();
    await fs.mkdir(path.join(host.dir, "assets"));
    const file = path.join(host.dir, "assets/hero.svg");
    await writeFile(file, '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const heroPath = await fs.realpath(file);
    const originalRead = fs.readFile.bind(fs);
    const read = vi
      .spyOn(fs, "readFile")
      .mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
        if (String(args[0]) === heroPath)
          throw Object.assign(new Error("Fixture hero read failed"), { code });
        return originalRead(...args);
      });
    try {
      const response = await fetch(
        new URL("/api/views/graph/hero", host.origin),
      );
      expect(response.status).toBe(status);
      if (status === 200)
        expect(response.headers.get("content-type")).toBe("image/svg+xml");
    } finally {
      read.mockRestore();
      await host.close();
    }
  },
);
