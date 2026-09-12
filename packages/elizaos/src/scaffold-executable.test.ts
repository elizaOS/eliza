/** Exercises rendered template executables through real POSIX subprocesses and verifies byte preservation. */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { renderTemplateTree } from "./scaffold.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

it.skipIf(process.platform === "win32")(
  "dispatches the rendered codesign wrapper by PATH and preserves normal files on rerender",
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "template-executable-"));
    roots.push(root);
    const source = path.join(root, "source");
    const dest = path.join(root, "dest");
    fs.mkdirSync(source);
    fs.mkdirSync(dest);
    const wrapper = fileURLToPath(
      new URL(
        "../templates/project/apps/app/electrobun/scripts/bin/codesign",
        import.meta.url,
      ),
    );
    fs.copyFileSync(wrapper, path.join(source, "codesign"));
    fs.chmodSync(path.join(source, "codesign"), 0o4755);
    fs.writeFileSync(path.join(dest, "codesign"), "stale");
    fs.chmodSync(path.join(dest, "codesign"), 0o600);
    fs.writeFileSync(path.join(source, "settings.txt"), "__NAME__");
    fs.chmodSync(path.join(source, "settings.txt"), 0o644);
    fs.writeFileSync(path.join(dest, "settings.txt"), "stale");
    fs.chmodSync(path.join(dest, "settings.txt"), 0o755);
    const bytes = Buffer.from([0, 255, 10, 42]);
    fs.writeFileSync(path.join(source, "data.bin"), bytes);
    const realCodesign = path.join(root, "controlled-codesign");
    fs.writeFileSync(realCodesign, '#!/bin/sh\nprintf "%s\\n" "$@"\n', {
      mode: 0o755,
    });
    const plutil = path.join(root, "controlled-plutil");
    fs.writeFileSync(plutil, '#!/bin/sh\nprintf "com.example.generated\\n"\n', {
      mode: 0o755,
    });
    const ledger = renderTemplateTree({
      sourceDir: source,
      destinationDir: dest,
      replacements: [["__NAME__", "Example"]],
    });
    const output = execFileSync(
      "/bin/sh",
      [
        "-c",
        "codesign --sign - --identifier stale /tmp/Example.app/Contents/MacOS/bun",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${dest}:${process.env.PATH}`,
          ELIZA_REAL_CODESIGN: realCodesign,
          ELIZA_REAL_PLUTIL: plutil,
        },
      },
    );
    expect(output.trim().split("\n")).toEqual([
      "--sign",
      "-",
      "--identifier",
      "com.example.generated",
      "/tmp/Example.app/Contents/MacOS/bun",
    ]);
    expect(fs.statSync(path.join(dest, "codesign")).mode & 0o7000).toBe(0);
    expect(fs.statSync(path.join(dest, "settings.txt")).mode & 0o111).toBe(0);
    expect(fs.readFileSync(path.join(dest, "settings.txt"), "utf8")).toBe(
      "Example",
    );
    expect(fs.readFileSync(path.join(dest, "data.bin"))).toEqual(bytes);
    for (const [name, hash] of Object.entries(ledger))
      expect(
        createHash("sha256")
          .update(fs.readFileSync(path.join(dest, name)))
          .digest("hex"),
      ).toBe(hash);
  },
);

it.skipIf(process.platform === "win32")(
  "repairs an existing generated executable without changing its managed bytes",
  async () => {
    const { updateManagedFiles } = await import("./scaffold.js");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "upgrade-executable-"));
    roots.push(root);
    const source = path.join(root, "source");
    const project = path.join(root, "project");
    const rendered = path.join(root, "rendered");
    fs.mkdirSync(source);
    fs.mkdirSync(project);
    fs.writeFileSync(
      path.join(source, "run"),
      '#!/bin/sh\nprintf "upgraded-executable\\n"\n',
      { mode: 0o755 },
    );
    const ledger = renderTemplateTree({
      sourceDir: source,
      destinationDir: rendered,
      replacements: [],
    });
    fs.copyFileSync(path.join(rendered, "run"), path.join(project, "run"));
    fs.chmodSync(path.join(project, "run"), 0o644);
    const currentMetadata = {
      cliVersion: "test",
      createdAt: "test",
      updatedAt: "test",
      templateVersion: 1,
      templateId: "project",
      values: {},
      managedFiles: ledger,
    } as const;
    const options = {
      currentMetadata,
      projectRoot: project,
      renderedDir: rendered,
      renderedManagedFiles: ledger,
    };
    const preview = updateManagedFiles({ ...options, dryRun: true });
    expect(preview.updated).toEqual(["run"]);
    expect(fs.statSync(path.join(project, "run")).mode & 0o111).toBe(0);
    const result = updateManagedFiles(options);
    expect(execFileSync(path.join(project, "run"), { encoding: "utf8" })).toBe(
      "upgraded-executable\n",
    );
    expect(result.nextManagedFiles).toEqual(ledger);
    expect(updateManagedFiles(options).updated).toEqual([]);
  },
);
