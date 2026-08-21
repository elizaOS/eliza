/**
 * Tests the canonical file boot mechanism: composing an allowlisted set of
 * on-disk files into the boot character's system prompt, with a sha256 audit
 * per file, loud failure on a missing REQUIRED file, and a canary proof that a
 * changed line in an allowed file reaches the composed boot context.
 *
 * FILE FIREWALL: every fixture here is SYNTHETIC. No real SOUL.md / USER.md /
 * memory content is read or embedded. Tests inject a fake fs or write throwaway
 * files into an os tmpdir, then delete them.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ElizaConfig } from "../config/config.ts";
import {
  applyCanonicalFileBootToConfig,
  CANONICAL_BOOT_MANIFEST_ENV,
  CANONICAL_BOOT_ROOT_ENV,
  type CanonicalBootFs,
  composeCanonicalBootContext,
  DEFAULT_CANONICAL_MANIFEST,
  type ResolvedCanonicalEntry,
  resolveCanonicalManifest,
} from "./canonical-file-boot.ts";

// A synthetic in-memory fs: label/path -> content. Anything not present throws
// (ENOENT-like), which the composer treats as "file absent".
function fakeFs(files: Record<string, string>): CanonicalBootFs {
  return {
    readFileSync(path: string) {
      if (path in files) return files[path];
      throw new Error(`ENOENT: ${path}`);
    },
  };
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function absoluteFixturePath(...segments: string[]): string {
  return resolve(sep, ...segments);
}

const ENV_KEYS = [CANONICAL_BOOT_ROOT_ENV, CANONICAL_BOOT_MANIFEST_ENV];
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("resolveCanonicalManifest", () => {
  it("is inert (returns null) when no env is configured", () => {
    expect(resolveCanonicalManifest({}, fakeFs({}))).toBeNull();
  });

  it("resolves the default manifest under ELIZA_CANONICAL_BOOT_ROOT", () => {
    const root = absoluteFixturePath("srv", "ws");
    const manifest = resolveCanonicalManifest(
      { [CANONICAL_BOOT_ROOT_ENV]: root },
      fakeFs({}),
    );
    expect(manifest).not.toBeNull();
    expect(manifest?.length).toBe(DEFAULT_CANONICAL_MANIFEST.length);
    const soul = manifest?.find((e) => e.label === "SOUL.md");
    expect(soul?.path).toBe(join(root, "SOUL.md"));
    expect(soul?.required).toBe(true);
    const handoff = manifest?.find((e) => e.label === "memory/HANDOFF.md");
    expect(handoff?.path).toBe(join(root, "memory", "HANDOFF.md"));
    expect(handoff?.required).toBe(false);
  });

  it("resolves an explicit JSON manifest with its own root + required flags", () => {
    const manifestPath = absoluteFixturePath("cfg", "manifest.json");
    const root = absoluteFixturePath("data", "agent");
    const absoluteEntryPath = absoluteFixturePath("etc", "agent", "extra.md");
    const manifestJson = JSON.stringify({
      root,
      files: [
        { label: "SOUL", path: "soul.md", required: true },
        { label: "ABS", path: absoluteEntryPath },
      ],
    });
    const manifest = resolveCanonicalManifest(
      { [CANONICAL_BOOT_MANIFEST_ENV]: manifestPath },
      fakeFs({ [manifestPath]: manifestJson }),
    );
    expect(manifest).toHaveLength(2);
    expect(manifest?.[0]).toEqual({
      label: "SOUL",
      path: join(root, "soul.md"),
      required: true,
    });
    // absolute path passes through unchanged
    expect(manifest?.[1].path).toBe(absoluteEntryPath);
    expect(manifest?.[1].required).toBe(false);
  });

  it("throws loudly on a broken/unreadable manifest file", () => {
    expect(() =>
      resolveCanonicalManifest(
        { [CANONICAL_BOOT_MANIFEST_ENV]: "/cfg/missing.json" },
        fakeFs({}),
      ),
    ).toThrow(/Failed to read\/parse manifest/);
  });
});

describe("composeCanonicalBootContext", () => {
  const soulBody = "SYNTHETIC SOUL: be kind, be sharp. canary=ALPHA-1";
  const idBody = "SYNTHETIC IDENTITY: name is TestAgent.";

  function manifest(root = "/ws"): ResolvedCanonicalEntry[] {
    return [
      { label: "SOUL.md", path: `${root}/SOUL.md`, required: true },
      { label: "IDENTITY.md", path: `${root}/IDENTITY.md`, required: true },
      {
        label: "memory/HANDOFF.md",
        path: `${root}/memory/HANDOFF.md`,
        required: false,
      },
    ];
  }

  it("composes present files with a correct sha256 per file, skips absent optional", () => {
    const fs = fakeFs({
      "/ws/SOUL.md": soulBody,
      "/ws/IDENTITY.md": idBody,
      // HANDOFF.md deliberately absent (optional)
    });
    const { text, audit } = composeCanonicalBootContext(manifest(), {
      fs,
      log: false,
    });

    // exact content is present verbatim
    expect(text).toContain(soulBody);
    expect(text).toContain(idBody);
    // sha256 in header matches the actual bytes
    expect(text).toContain(`sha256=${sha256(soulBody)}`);
    expect(text).toContain(`sha256=${sha256(idBody)}`);

    const soulAudit = audit.find((a) => a.label === "SOUL.md");
    expect(soulAudit?.present).toBe(true);
    expect(soulAudit?.sha256).toBe(sha256(soulBody));
    expect(soulAudit?.bytes).toBe(Buffer.byteLength(soulBody, "utf8"));

    const handoffAudit = audit.find((a) => a.label === "memory/HANDOFF.md");
    expect(handoffAudit?.present).toBe(false);
    expect(handoffAudit?.sha256).toBeNull();
  });

  it("throws loudly when a REQUIRED file is missing", () => {
    const fs = fakeFs({ "/ws/IDENTITY.md": idBody }); // SOUL.md missing
    expect(() =>
      composeCanonicalBootContext(manifest(), { fs, log: false }),
    ).toThrow(/Required canonical file missing or empty: SOUL\.md/);
  });

  it("throws loudly when a REQUIRED file is present but empty", () => {
    const fs = fakeFs({ "/ws/SOUL.md": "   \n  ", "/ws/IDENTITY.md": idBody });
    expect(() =>
      composeCanonicalBootContext(manifest(), { fs, log: false }),
    ).toThrow(/Required canonical file missing or empty: SOUL\.md/);
  });

  it("CANARY: a changed line in an allowed file appears in composed context", () => {
    const before = composeCanonicalBootContext(manifest(), {
      fs: fakeFs({
        "/ws/SOUL.md": "SYNTHETIC SOUL canary=BEFORE-VALUE",
        "/ws/IDENTITY.md": idBody,
      }),
      log: false,
    });
    expect(before.text).toContain("canary=BEFORE-VALUE");
    expect(before.text).not.toContain("canary=AFTER-VALUE");

    // "edit the file + reboot" == recompose from the mutated fs
    const after = composeCanonicalBootContext(manifest(), {
      fs: fakeFs({
        "/ws/SOUL.md": "SYNTHETIC SOUL canary=AFTER-VALUE",
        "/ws/IDENTITY.md": idBody,
      }),
      log: false,
    });
    expect(after.text).toContain("canary=AFTER-VALUE");
    expect(after.text).not.toContain("canary=BEFORE-VALUE");
    // the sha256 changed too, proving byte-exact tracking
    const beforeSha = before.audit.find((a) => a.label === "SOUL.md")?.sha256;
    const afterSha = after.audit.find((a) => a.label === "SOUL.md")?.sha256;
    expect(beforeSha).not.toBe(afterSha);
  });
});

describe("applyCanonicalFileBootToConfig", () => {
  it("is inert when no env configured (config unchanged)", () => {
    const config: ElizaConfig = {
      agents: { list: [{ id: "main", default: true, name: "X", system: "S" }] },
    } as unknown as ElizaConfig;
    const out = applyCanonicalFileBootToConfig(config, {}, { log: false });
    expect(out.agents?.list?.[0].system).toBe("S");
  });

  it("appends composed files onto the existing primary system prompt", () => {
    const root = absoluteFixturePath("ws");
    const config: ElizaConfig = {
      agents: {
        list: [{ id: "main", default: true, name: "X", system: "BASE-PROMPT" }],
      },
    } as unknown as ElizaConfig;

    // use an explicit manifest of only the 4 required-ish synthetic files
    const manifestPath = absoluteFixturePath("cfg", "m.json");
    const fsWithManifest = fakeFs({
      [join(root, "SOUL.md")]: "SYNTHETIC SOUL canary=APPEND-OK",
      [join(root, "IDENTITY.md")]: "SYNTHETIC IDENTITY",
      [join(root, "AGENTS.md")]: "SYNTHETIC AGENTS",
      [join(root, "USER.md")]: "SYNTHETIC USER",
      [manifestPath]: JSON.stringify({
        root,
        files: [
          { label: "SOUL.md", path: "SOUL.md", required: true },
          { label: "USER.md", path: "USER.md", required: true },
        ],
      }),
    });

    const out = applyCanonicalFileBootToConfig(
      config,
      { [CANONICAL_BOOT_MANIFEST_ENV]: manifestPath },
      { fs: fsWithManifest, log: false },
    );
    const sys = out.agents?.list?.[0].system ?? "";
    expect(sys.startsWith("BASE-PROMPT")).toBe(true);
    expect(sys).toContain("canary=APPEND-OK");
    expect(sys).toContain("SYNTHETIC USER");
  });

  it("creates a primary entry when none exists", () => {
    const manifestPath = absoluteFixturePath("cfg", "m.json");
    const root = absoluteFixturePath("ws");
    const fs = fakeFs({
      [join(root, "SOUL.md")]: "SYNTHETIC SOUL",
      [manifestPath]: JSON.stringify({
        root,
        files: [{ label: "SOUL.md", path: "SOUL.md", required: true }],
      }),
    });
    const config: ElizaConfig = {
      agents: { list: [] },
    } as unknown as ElizaConfig;
    const out = applyCanonicalFileBootToConfig(
      config,
      { [CANONICAL_BOOT_MANIFEST_ENV]: manifestPath },
      { fs, log: false },
    );
    expect(out.agents?.list?.[0].default).toBe(true);
    expect(out.agents?.list?.[0].system).toContain("SYNTHETIC SOUL");
  });
});

describe("real-disk round trip (synthetic tmpdir fixtures + canary reboot)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "canon-boot-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads default-manifest required files off disk and canary-flips on rewrite", () => {
    // Write only the 4 required synthetic files under the root.
    writeFileSync(join(dir, "SOUL.md"), "SOUL canary=DISK-V1");
    writeFileSync(join(dir, "IDENTITY.md"), "IDENTITY synthetic");
    writeFileSync(join(dir, "AGENTS.md"), "AGENTS synthetic");
    writeFileSync(join(dir, "USER.md"), "USER synthetic");

    const env = { [CANONICAL_BOOT_ROOT_ENV]: dir } as NodeJS.ProcessEnv;
    const m1 = resolveCanonicalManifest(env);
    if (!m1) throw new Error("expected canonical manifest for boot root");
    const c1 = composeCanonicalBootContext(m1, { log: false });
    expect(c1.text).toContain("canary=DISK-V1");

    // "restart" after editing the file
    writeFileSync(join(dir, "SOUL.md"), "SOUL canary=DISK-V2");
    const m2 = resolveCanonicalManifest(env);
    if (!m2) throw new Error("expected canonical manifest after rewrite");
    const c2 = composeCanonicalBootContext(m2, {
      log: false,
    });
    expect(c2.text).toContain("canary=DISK-V2");
    expect(c2.text).not.toContain("canary=DISK-V1");
  });
});
