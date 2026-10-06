import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const script = fileURLToPath(
  new URL("../scripts/gen-view-icons.ts", import.meta.url),
);
it.each(["api-error", "download-error", "success"])(
  "generates with staged output and truthful status: %s",
  (scenario) => {
    const root = mkdtempSync(join(tmpdir(), "gen-view-icons-"));
    try {
      const bin = join(root, "bin");
      mkdirSync(bin);
      const renderer = join(bin, "rsvg-convert");
      writeFileSync(
        renderer,
        '#!/bin/sh\nif [ "$1" = "--version" ]; then exit 0; fi\nwhile [ "$#" -gt 0 ]; do\nif [ "$1" = "-o" ]; then printf "png-fixture" > "$2"; exit 0; fi\nshift\ndone\nexit 1\n',
      );
      chmodSync(renderer, 0o755);
      const mock = join(root, "fetch.mjs");
      writeFileSync(
        mock,
        `globalThis.fetch = async (url) => {
      if (url.startsWith("https://fal.run/")) return new Response(JSON.stringify({ images: [{ url: "https://fixture.invalid/icon.svg" }] }), { status: ${scenario === "api-error" ? 503 : 200} });
      if (url === "https://fixture.invalid/icon.svg") return new Response('<svg viewBox="0 0 10 10"><path d="M 1 1 L 2 2"></path></svg>', { status: ${scenario === "download-error" ? 503 : 200} });
      throw new Error("Unexpected network request: " + url);
    };`,
      );
      const destination = join(root, "icons");
      let status = 0;
      try {
        execFileSync(
          process.execPath,
          ["--import", mock, script, "--out", destination, "default"],
          {
            env: { ...process.env, PATH: bin, FAL_KEY: "offline-test" },
            stdio: "pipe",
          },
        );
      } catch (error) {
        status = error.status ?? -1;
      }
      if (scenario === "success") {
        expect(status).toBe(0);
        expect(readFileSync(join(destination, "default.png"), "utf8")).toBe(
          "png-fixture",
        );
        const manifest = JSON.parse(
          readFileSync(join(destination, "manifest.json"), "utf8"),
        );
        expect(manifest.generated).toEqual(["default"]);
        expect(manifest.expected).toContain("chat");
      } else {
        expect(status).not.toBe(0);
        expect(existsSync(destination)).toBe(false);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
