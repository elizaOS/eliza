import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AOSP_ESPEAK_GROUP,
  AOSP_VOICE_GROUPS,
  AOSP_VOICE_RECORD,
  aospAsrModelPath,
  aospEspeakDataParent,
  aospParadeePaths,
  aospVoiceFiles,
  aospVoiceGroupFiles,
  aospVoiceGroupNeedsStaging,
  downloadAospVoiceAsset,
  expectedAospVoicePin,
  readAospVoiceLocalSource,
  stageAospVoiceGroup,
} from "../src/aosp-voice-download.js";
import {
  DEFAULT_NETWORK_POLICY_PREFERENCES,
  type RawNetworkState,
} from "../src/model-catalog/network-policy.js";
import {
  isPublishedMobileVoiceFile,
  type MobileVoiceFile,
  mobileVoiceBundle,
  VOICE_MODEL_VERSIONS,
} from "../src/model-catalog/voice-models.js";

const roots: string[] = [];
const bytes = Buffer.from("complete model fixture");
const asset = {
  url: "https://huggingface.co/fixture/pinned/model",
  sizeBytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
};
const allowed = async (): Promise<RawNetworkState> => ({
  connectionType: "wifi",
  metered: false,
});
function destination() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "aosp-voice-download-"));
  roots.push(dir);
  return path.join(dir, "model");
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("AOSP automatic voice download", () => {
  it("retains the complete verified bytes on an allowed network", async () => {
    const target = destination();
    let probes = 0;
    await downloadAospVoiceAsset(asset, target, {
      preferences: { ...DEFAULT_NETWORK_POLICY_PREFERENCES, quietHours: [] },
      probe: async () => {
        probes++;
        return allowed();
      },
      fetchImpl: (async () => new Response(bytes)) as typeof fetch,
    });
    expect(readFileSync(target)).toEqual(bytes);
    expect(probes).toBeGreaterThanOrEqual(2);
  });
  for (const state of [
    { connectionType: "wifi", metered: true },
    { connectionType: "unknown", metered: null },
    { connectionType: "none", metered: null },
  ] as const) {
    it(`does not fetch on ${state.connectionType}/${state.metered}`, async () => {
      const target = destination();
      let fetched = false;
      await expect(
        downloadAospVoiceAsset(asset, target, {
          preferences: {
            ...DEFAULT_NETWORK_POLICY_PREFERENCES,
            quietHours: [],
          },
          probe: async () => state,
          fetchImpl: (async () => {
            fetched = true;
            return new Response(bytes);
          }) as typeof fetch,
        }),
      ).rejects.toThrow("allowed network");
      expect(fetched).toBe(false);
      expect(existsSync(target)).toBe(false);
    });
  }
  it("rejects changed network state before completing publication", async () => {
    let probes = 0;
    await expect(
      downloadAospVoiceAsset(asset, destination(), {
        preferences: { ...DEFAULT_NETWORK_POLICY_PREFERENCES, quietHours: [] },
        probe: async () =>
          ++probes === 1
            ? allowed()
            : { connectionType: "wifi", metered: true },
        now: (() => {
          let clock = 0;
          return () => (clock += 1001);
        })(),
        fetchImpl: (async () => new Response(bytes)) as typeof fetch,
      }),
    ).rejects.toThrow("allowed network");
    expect(probes).toBe(2);
  });
  it("rejects host loss during transfer", async () => {
    let probes = 0;
    await expect(
      downloadAospVoiceAsset(asset, destination(), {
        preferences: { ...DEFAULT_NETWORK_POLICY_PREFERENCES, quietHours: [] },
        probe: async () => {
          if (++probes > 1) throw new Error("host unavailable");
          return allowed();
        },
        now: (() => {
          let clock = 0;
          return () => (clock += 1001);
        })(),
        fetchImpl: (async () => new Response(bytes)) as typeof fetch,
      }),
    ).rejects.toThrow("host unavailable");
  });
  for (const received of [
    Buffer.from("incomplete"),
    Buffer.alloc(bytes.length),
    Buffer.alloc(bytes.length + 1),
  ]) {
    it(`rejects corrupt or incorrectly sized bytes (${received.length})`, async () => {
      await expect(
        downloadAospVoiceAsset(asset, destination(), {
          preferences: {
            ...DEFAULT_NETWORK_POLICY_PREFERENCES,
            quietHours: [],
          },
          probe: allowed,
          fetchImpl: (async () => new Response(received)) as typeof fetch,
        }),
      ).rejects.toThrow();
    });
  }
});

describe("pinned mobile voice bundle", () => {
  const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
  const allowedNetwork = {
    preferences: { ...DEFAULT_NETWORK_POLICY_PREFERENCES, quietHours: [] },
    probe: allowed,
  };
  function bundleRoot() {
    const dir = mkdtempSync(path.join(os.tmpdir(), "aosp-voice-bundle-"));
    roots.push(dir);
    return dir;
  }
  function published(
    id: string,
    role: MobileVoiceFile["role"],
    filePath: string,
    data: Buffer,
  ): MobileVoiceFile {
    return {
      id,
      role,
      path: filePath,
      hfRepo: "fixture/repo",
      hfPath: path.posix.basename(filePath),
      url: `https://huggingface.co/fixture/repo/resolve/${"a".repeat(40)}/${path.posix.basename(filePath)}`,
      revision: "a".repeat(40),
      sha256: sha(data),
      bytes: data.length,
      license: "Apache-2.0",
      status: "published",
      source: { repo: "fixture/upstream", revision: "b".repeat(40) },
    };
  }
  function unpublished(
    id: string,
    role: MobileVoiceFile["role"],
    filePath: string,
  ): MobileVoiceFile {
    return {
      id,
      role,
      path: filePath,
      hfRepo: "elizaos/eliza-1",
      hfPath: `voice/paradee/${path.posix.basename(filePath)}`,
      url: null,
      revision: null,
      sha256: null,
      bytes: null,
      license: "Apache-2.0",
      status: "unpublished",
      localFrom: "fixture pins.json",
      source: { repo: "fixture/upstream", revision: "c".repeat(40) },
    };
  }

  it("pins every catalog row it would download and keeps ONNX out", () => {
    const files = aospVoiceFiles();
    expect([...new Set(files.map((f) => f.role))].sort()).toEqual(
      ["asr-parakeet", "g2p-espeak-data", "g2p-lexicon", "tts", "vad"].sort(),
    );
    for (const file of files) {
      expect(file.path.toLowerCase()).not.toContain(".onnx");
      expect(file.path).not.toContain("kokoro");
      if (file.status === "published") {
        expect(isPublishedMobileVoiceFile(file)).toBe(true);
      } else {
        // Unpublished rows carry no URL, so nothing can download them. A row
        // with a byte-reproducible build pins its sha256 and size.
        expect(file.url).toBeNull();
        expect(file.revision).toBeNull();
        expect(isPublishedMobileVoiceFile(file)).toBe(false);
        expect(file.localFrom).toBeTruthy();
        expect(file.sha256 === null).toBe(file.bytes === null);
      }
    }
    for (const group of AOSP_VOICE_GROUPS) {
      const rows = aospVoiceGroupFiles(group);
      if (group === AOSP_ESPEAK_GROUP) expect(rows.length).toBe(7);
      else expect(rows.length).toBe(group.roles.length);
    }
    const asr = files.filter((f) => f.role.startsWith("asr-"));
    expect(asr.map((f) => f.sha256)).toEqual([
      "dc552eb786486167dde3ac80bbe49a6088c8ef39c03c257d5a090fc57b2c47b3",
    ]);
    const vad = files.find((f) => f.role === "vad");
    expect(vad?.sha256).toBe(
      "d348cd6d87ea53dcd3e6680698c88be326082e27dae899adef653d090bee4995",
    );
    expect(vad?.revision).toBe("1e4c73713e11f7ff42bc2a686cc5b178c8cac14f");
  });

  it("names the Paradee GGUF and eSpeak NG data the way every loader expects", () => {
    const repo = path.resolve(import.meta.dir, "../../..");
    const read = (rel: string) => readFileSync(path.join(repo, rel), "utf8");
    const files = aospVoiceFiles();
    const tts = files.find((f) => f.role === "tts");
    const lexicon = files.find((f) => f.role === "g2p-lexicon");
    // packages/app/platforms/android/paradee-voice/inputs.json is what the
    // paradee-voice build stages; the catalog must name the same files.
    const inputs = JSON.parse(
      read("packages/app/platforms/android/paradee-voice/inputs.json"),
    );
    expect(tts?.path).toBe("tts/paradee/paradee-8m-v1_0.gguf");
    expect(tts?.path).toBe(inputs.paradee.path);
    expect(tts?.hfPath).toBe("voice/paradee/paradee-8m-v1_0.gguf");
    expect({ sha256: tts?.sha256, bytes: tts?.bytes }).toEqual({
      sha256: inputs.paradee.sha256,
      bytes: inputs.paradee.bytes,
    });
    expect(lexicon?.path).toBe(inputs.lexicon.path);
    expect({ sha256: lexicon?.sha256, bytes: lexicon?.bytes }).toEqual({
      sha256: inputs.lexicon.sha256,
      bytes: inputs.lexicon.bytes,
    });
    // ElizaBionicInferenceServer and the host worker load the same name.
    expect(
      read(
        "packages/app/platforms/android/app/src/main/java/ai/elizaos/app/ElizaBionicInferenceServer.java",
      ),
    ).toContain(`PARADEE_MODEL = "${path.posix.basename(tts?.path ?? "")}"`);
    expect(
      read("plugins/plugin-local-inference/src/host-tts-worker.ts"),
    ).toContain(`path: "${path.posix.basename(tts?.path ?? "")}"`);
    const catalog = read(
      "plugins/plugin-native-inference/src/model-catalog/voice-model-versions.json",
    );
    expect(catalog).not.toContain("paradee-8m-v1.0.gguf");
    expect(aospParadeePaths("/b").gguf).toBe(
      path.join("/b", "tts", "paradee", "paradee-8m-v1_0.gguf"),
    );

    // eSpeak NG data: the files inputs.json builds, with the host worker's pins.
    const espeak = files.filter((f) => f.role === "g2p-espeak-data");
    expect(espeak.map((f) => f.path).sort()).toEqual(
      (inputs.espeak.data as string[])
        .map((rel) => `tts/paradee/espeak-ng-data/${rel}`)
        .sort(),
    );
    const worker = read(
      "plugins/plugin-local-inference/src/host-tts-worker.ts",
    );
    for (const row of espeak) {
      expect(row.status).toBe("unpublished");
      expect(row.license).toBe("GPL-3.0-or-later");
      expect(row.licenseFlags?.length).toBeGreaterThan(0);
      const rel = row.path.slice("tts/paradee/".length);
      expect(worker).toMatch(
        new RegExp(
          `path: "${rel}",\\s*sha256: "${row.sha256}",\\s*bytes: ${String(row.bytes).replace(/\B(?=(\d{3})+(?!\d))/g, "_")},`,
        ),
      );
    }
    const groups = AOSP_VOICE_GROUPS;
    expect(groups.indexOf(AOSP_ESPEAK_GROUP)).toBe(
      groups.findIndex((g) => g.dir === "tts/paradee") + 1,
    );
  });

  it("stages the nested eSpeak NG group only after tts/paradee and reports its directory", async () => {
    const data = {
      phontab: Buffer.from("phontab"),
      "lang/gmw/en": Buffer.from("en voice"),
    };
    const rows: MobileVoiceFile[] = Object.entries(data).map(([rel, buf]) => ({
      ...unpublished(
        `espeak-${rel}`,
        "g2p-espeak-data",
        `tts/paradee/espeak-ng-data/${rel}`,
      ),
      sha256: sha(buf),
      bytes: buf.length,
      license: "GPL-3.0-or-later",
    }));
    const source = bundleRoot();
    for (const [rel, buf] of Object.entries(data)) {
      const file = path.join(source, "tts", "paradee", "espeak-ng-data", rel);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, buf);
    }
    const local = readAospVoiceLocalSource(source);
    const root = bundleRoot();
    // tts/paradee is not staged: nothing is written, so the outer group
    // cannot look present.
    const early = await stageAospVoiceGroup(root, AOSP_ESPEAK_GROUP, {
      files: rows,
      local,
    });
    expect(early.status).toBe("unavailable");
    expect(existsSync(path.join(root, "tts"))).toBe(false);
    expect(aospEspeakDataParent(root, rows)).toBeNull();

    mkdirSync(path.join(root, "tts", "paradee"), { recursive: true });
    const staged = await stageAospVoiceGroup(root, AOSP_ESPEAK_GROUP, {
      files: rows,
      local,
    });
    expect(staged.status).toBe("staged");
    expect(
      readFileSync(
        path.join(
          root,
          "tts",
          "paradee",
          "espeak-ng-data",
          "lang",
          "gmw",
          "en",
        ),
      ),
    ).toEqual(data["lang/gmw/en"]);
    expect(
      existsSync(path.join(root, "tts", "paradee", "espeak-ng-data.staging")),
    ).toBe(false);
    expect(aospEspeakDataParent(root, rows)).toBe(
      path.join(root, "tts", "paradee"),
    );
    expect(
      (await stageAospVoiceGroup(root, AOSP_ESPEAK_GROUP, { files: rows }))
        .status,
    ).toBe("present");

    writeFileSync(
      path.join(root, "tts", "paradee", "espeak-ng-data", "phontab"),
      "tampered",
    );
    await expect(
      stageAospVoiceGroup(root, AOSP_ESPEAK_GROUP, { files: rows }),
    ).rejects.toThrow("does not match its pin");

    const escaping = {
      ...rows[0],
      path: "tts/paradee/espeak-ng-data/../paradee.gguf",
    } as MobileVoiceFile;
    expect(() => aospVoiceGroupFiles(AOSP_ESPEAK_GROUP, [escaping])).toThrow(
      "outside group",
    );
    const nestedSingle = unpublished("x", "tts", "tts/paradee/sub/x.gguf");
    expect(() =>
      aospVoiceGroupFiles({ dir: "tts/paradee", roles: ["tts"] }, [
        nestedSingle,
      ]),
    ).toThrow("outside group");
  });

  it("restages a group whose recorded file name differs from the catalog", async () => {
    const gguf = Buffer.from("paradee gguf");
    const oldRow: MobileVoiceFile = {
      ...unpublished("paradee", "tts", "tts/paradee/paradee-8m-v1.0.gguf"),
      sha256: sha(gguf),
      bytes: gguf.length,
    };
    const newRow: MobileVoiceFile = {
      ...oldRow,
      path: "tts/paradee/paradee-8m-v1_0.gguf",
    };
    const group = { dir: "tts/paradee", roles: ["tts"] } as const;
    const oldSource = bundleRoot();
    mkdirSync(path.join(oldSource, "tts", "paradee"), { recursive: true });
    writeFileSync(
      path.join(oldSource, "tts", "paradee", "paradee-8m-v1.0.gguf"),
      gguf,
    );
    const root = bundleRoot();
    await stageAospVoiceGroup(root, group, {
      files: [oldRow],
      local: readAospVoiceLocalSource(oldSource),
    });
    expect(aospVoiceGroupNeedsStaging(root, group, [oldRow])).toBe(false);
    expect(aospVoiceGroupNeedsStaging(root, group, [newRow])).toBe(true);

    const newSource = bundleRoot();
    mkdirSync(path.join(newSource, "tts", "paradee"), { recursive: true });
    writeFileSync(
      path.join(newSource, "tts", "paradee", "paradee-8m-v1_0.gguf"),
      gguf,
    );
    const result = await stageAospVoiceGroup(root, group, {
      files: [newRow],
      local: readAospVoiceLocalSource(newSource),
    });
    expect(result.status).toBe("staged");
    expect(
      existsSync(path.join(root, "tts", "paradee", "paradee-8m-v1_0.gguf")),
    ).toBe(true);
    expect(
      existsSync(path.join(root, "tts", "paradee", "paradee-8m-v1.0.gguf")),
    ).toBe(false);
  });

  it("makes Phonon-2 the only ASR and drops the Qwen3-ASR rows", () => {
    const bundle = mobileVoiceBundle();
    expect(bundle.version).toBe("1.2.0");
    expect(bundle.parentVersion).toBe("1.1.0");
    for (const file of bundle.files) {
      expect(file.id).not.toMatch(/qwen/i);
      expect(file.path).not.toMatch(/qwen|mmproj/i);
      expect(["asr-text", "asr-mmproj"]).not.toContain(file.role);
    }
    // The history keeps the earlier versions unchanged.
    const history = VOICE_MODEL_VERSIONS.filter(
      (v) => v.id === "mobile-voice",
    ).map((v) => v.version);
    expect(history).toEqual(["1.2.0", "1.1.0", "1.0.0"]);
    const phonon = aospVoiceFiles().find((f) => f.role === "asr-parakeet");
    expect(phonon).toMatchObject({
      id: "phonon-2-fv5",
      asrBackend: "parakeet",
      path: "asr/phonon-2-fv5.gguf",
      sha256:
        "dc552eb786486167dde3ac80bbe49a6088c8ef39c03c257d5a090fc57b2c47b3",
      bytes: 330632256,
      license: "CC-BY-4.0",
      status: "unpublished",
      notice: {
        path: "NOTICE",
        sha256:
          "00624a5043e7ce74029317b024132ca5286116d6fbf3191d226374bc8273789f",
        bytes: 2741,
        ggufKey: "parakeet.notice",
      },
      source: {
        repo: "FermionResearch/Phonon-2",
        revision: "7e153e4054c0a10db6d47d6fff5c062d4c77c154",
      },
    });
    expect(phonon?.attribution).toContain("CC-BY-4.0");
    expect(phonon?.source.converterCommand).toContain(
      "convert_phonon2_to_gguf.py --archive phonon-2.bps.tar.zst",
    );
    expect(phonon?.source.files?.[0]).toEqual({
      path: "phonon-2.bps.tar.zst",
      sha256:
        "98125795b6dda72f5c6eee9ba33d19815df65dcb18b50a357bf9f73c9935309e",
      bytes: 163515201,
    });

    expect(AOSP_VOICE_GROUPS.find((g) => g.dir === "asr")?.roles).toEqual([
      "asr-parakeet",
    ]);
    expect(aospAsrModelPath("/b")).toBe(
      path.join("/b", "asr", "phonon-2-fv5.gguf"),
    );
  });

  it("stages a catalog-pinned unpublished row from a local copy without voice-pins.json", async () => {
    const gguf = Buffer.from("phonon gguf");
    const row: MobileVoiceFile = {
      ...unpublished("phonon", "asr-parakeet", "asr/phonon.gguf"),
      sha256: sha(gguf),
      bytes: gguf.length,
    };
    const group = { dir: "asr", roles: ["asr-parakeet"] } as const;
    const source = bundleRoot();
    mkdirSync(path.join(source, "asr"));
    writeFileSync(path.join(source, "asr", "phonon.gguf"), gguf);
    expect(expectedAospVoicePin(row)).toEqual({
      sha256: sha(gguf),
      bytes: gguf.length,
    });
    expect(() =>
      expectedAospVoicePin(row, {
        dir: source,
        pins: { phonon: { sha256: "0".repeat(64), bytes: gguf.length } },
      }),
    ).toThrow("disagrees with the catalog");

    const root = bundleRoot();
    // No local source: never downloaded.
    expect(
      (await stageAospVoiceGroup(root, group, { files: [row] })).status,
    ).toBe("unavailable");
    const result = await stageAospVoiceGroup(root, group, {
      files: [row],
      local: readAospVoiceLocalSource(source),
    });
    expect(result.status).toBe("staged");
    expect(readFileSync(path.join(root, "asr", "phonon.gguf"))).toEqual(gguf);
    expect(
      (await stageAospVoiceGroup(root, group, { files: [row] })).status,
    ).toBe("present");

    writeFileSync(path.join(source, "asr", "phonon.gguf"), "tampered!!!");
    const other = bundleRoot();
    await expect(
      stageAospVoiceGroup(other, group, {
        files: [row],
        local: readAospVoiceLocalSource(source),
      }),
    ).rejects.toThrow("does not match its pin");
    expect(existsSync(path.join(other, "asr"))).toBe(false);
  });

  it("replaces a staged Qwen3-ASR group only after Phonon-2 is verified", async () => {
    const text = Buffer.from("qwen text");
    const proj = Buffer.from("qwen proj");
    const gguf = Buffer.from("phonon gguf");
    const retired: MobileVoiceFile[] = [
      published("q", "asr-text", "asr/text.gguf", text),
      published("m", "asr-mmproj", "asr/mmproj.gguf", proj),
    ];
    const phonon: MobileVoiceFile = {
      ...unpublished("phonon", "asr-parakeet", "asr/phonon.gguf"),
      sha256: sha(gguf),
      bytes: gguf.length,
    };
    const qwen = { dir: "asr", roles: ["asr-text", "asr-mmproj"] } as const;
    const parakeet = { dir: "asr", roles: ["asr-parakeet"] } as const;
    const stageRetired = async (root: string) => {
      await stageAospVoiceGroup(root, qwen, {
        ...allowedNetwork,
        files: retired,
        fetchImpl: (async (url: string) =>
          new Response(
            String(url).endsWith("mmproj.gguf") ? proj : text,
          )) as unknown as typeof fetch,
      });
      expect(readFileSync(path.join(root, "asr", "text.gguf"))).toEqual(text);
    };

    // Retain rollback bytes until a replacement is verified; this is not an ASR fallback.
    const bare = bundleRoot();
    await stageRetired(bare);
    expect(aospVoiceGroupNeedsStaging(bare, parakeet, [phonon])).toBe(true);
    const unavailable = await stageAospVoiceGroup(bare, parakeet, {
      files: [phonon],
    });
    expect(unavailable.status).toBe("unavailable");
    expect(readFileSync(path.join(bare, "asr", "text.gguf"))).toEqual(text);
    expect(readFileSync(path.join(bare, "asr", "mmproj.gguf"))).toEqual(proj);
    expect(aospVoiceGroupNeedsStaging(bare, parakeet, [phonon])).toBe(true);
    expect(existsSync(path.join(bare, "asr.retired.staging"))).toBe(false);

    const root = bundleRoot();
    await stageRetired(root);
    const source = bundleRoot();
    mkdirSync(path.join(source, "asr"));
    writeFileSync(path.join(source, "asr", "phonon.gguf"), "corrupt");
    await expect(
      stageAospVoiceGroup(root, parakeet, {
        files: [phonon],
        local: readAospVoiceLocalSource(source),
      }),
    ).rejects.toThrow("does not match its pin");
    expect(readFileSync(path.join(root, "asr", "text.gguf"))).toEqual(text);
    expect(readFileSync(path.join(root, "asr", "mmproj.gguf"))).toEqual(proj);
    expect(existsSync(path.join(root, "asr.staging"))).toBe(false);
    writeFileSync(path.join(source, "asr", "phonon.gguf"), gguf);
    const result = await stageAospVoiceGroup(root, parakeet, {
      files: [phonon],
      local: readAospVoiceLocalSource(source),
    });
    expect(result.status).toBe("staged");
    expect(readFileSync(path.join(root, "asr", "phonon.gguf"))).toEqual(gguf);
    // The retired files are gone, so the library's picker sees one model.
    expect(existsSync(path.join(root, "asr", "text.gguf"))).toBe(false);
    expect(existsSync(path.join(root, "asr", "mmproj.gguf"))).toBe(false);
    expect(existsSync(path.join(root, "asr.staging"))).toBe(false);
    expect(existsSync(path.join(root, "asr.retired.staging"))).toBe(false);
    expect(aospVoiceGroupNeedsStaging(root, parakeet, [phonon])).toBe(false);
    expect(
      (await stageAospVoiceGroup(root, parakeet, { files: [phonon] })).status,
    ).toBe("present");
  });

  it("downloads a published group into place atomically with a record", async () => {
    const model = Buffer.from("tts model");
    const lexicon = Buffer.from("tts lexicon");
    const files = [
      published("t", "tts", "tts/paradee/model.gguf", model),
      published("l", "g2p-lexicon", "tts/paradee/lexicon.lex", lexicon),
    ];
    const root = bundleRoot();
    const result = await stageAospVoiceGroup(
      root,
      { dir: "tts/paradee", roles: ["tts", "g2p-lexicon"] },
      {
        ...allowedNetwork,
        files,
        fetchImpl: (async (url: string) =>
          new Response(
            String(url).endsWith("lexicon.lex") ? lexicon : model,
          )) as unknown as typeof fetch,
      },
    );
    expect(result.status).toBe("staged");
    expect(
      readFileSync(path.join(root, "tts", "paradee", "model.gguf")),
    ).toEqual(model);
    expect(
      readFileSync(path.join(root, "tts", "paradee", "lexicon.lex")),
    ).toEqual(lexicon);
    expect(existsSync(path.join(root, "tts", "paradee.staging"))).toBe(false);
    const record = JSON.parse(
      readFileSync(
        path.join(root, "tts", "paradee", AOSP_VOICE_RECORD),
        "utf8",
      ),
    );
    expect(record.files.map((f: { origin: string }) => f.origin)).toEqual([
      "download",
      "download",
    ]);
  });

  it("removes staging and publishes nothing when a download is corrupt", async () => {
    const model = Buffer.from("tts model");
    const files = [
      published("t", "tts", "tts/paradee/model.gguf", model),
      published(
        "l",
        "g2p-lexicon",
        "tts/paradee/lexicon.lex",
        Buffer.from("lexicon"),
      ),
    ];
    const root = bundleRoot();
    await expect(
      stageAospVoiceGroup(
        root,
        { dir: "tts/paradee", roles: ["tts", "g2p-lexicon"] },
        {
          ...allowedNetwork,
          files,
          fetchImpl: (async () =>
            new Response(model)) as unknown as typeof fetch,
        },
      ),
    ).rejects.toThrow();
    expect(existsSync(path.join(root, "tts", "paradee"))).toBe(false);
    expect(existsSync(path.join(root, "tts", "paradee.staging"))).toBe(false);
  });

  it("never downloads an unpublished row and reports it unavailable", async () => {
    let fetched = false;
    const root = bundleRoot();
    const result = await stageAospVoiceGroup(
      root,
      { dir: "tts/paradee", roles: ["tts", "g2p-lexicon"] },
      {
        ...allowedNetwork,
        files: [
          unpublished("paradee", "tts", "tts/paradee/paradee.gguf"),
          unpublished("lexicon", "g2p-lexicon", "tts/paradee/misaki.lex"),
        ],
        fetchImpl: (async () => {
          fetched = true;
          return new Response("x");
        }) as unknown as typeof fetch,
      },
    );
    expect(result.status).toBe("unavailable");
    expect(fetched).toBe(false);
    expect(existsSync(path.join(root, "tts"))).toBe(false);
  });

  it("stages unpublished rows only from a local source that matches its pins", async () => {
    const gguf = Buffer.from("paradee gguf");
    const lex = Buffer.from("misaki lexicon");
    const source = bundleRoot();
    mkdirSync(path.join(source, "tts", "paradee"), { recursive: true });
    writeFileSync(path.join(source, "tts", "paradee", "paradee.gguf"), gguf);
    writeFileSync(path.join(source, "tts", "paradee", "misaki.lex"), lex);
    writeFileSync(
      path.join(source, "voice-pins.json"),
      JSON.stringify({
        paradee: { sha256: sha(gguf), bytes: gguf.length },
        lexicon: { sha256: sha(lex), bytes: lex.length },
      }),
    );
    const files = [
      unpublished("paradee", "tts", "tts/paradee/paradee.gguf"),
      unpublished("lexicon", "g2p-lexicon", "tts/paradee/misaki.lex"),
    ];
    const group = {
      dir: "tts/paradee",
      roles: ["tts", "g2p-lexicon"],
    } as const;
    const root = bundleRoot();
    const result = await stageAospVoiceGroup(root, group, {
      files,
      local: readAospVoiceLocalSource(source),
    });
    expect(result.status).toBe("staged");
    expect(
      readFileSync(path.join(root, "tts", "paradee", "paradee.gguf")),
    ).toEqual(gguf);
    // A second call verifies the original local pins without the source directory.
    expect((await stageAospVoiceGroup(root, group, { files })).status).toBe(
      "present",
    );

    writeFileSync(
      path.join(root, "tts", "paradee", "misaki.lex"),
      Buffer.alloc(lex.length),
    );
    await expect(stageAospVoiceGroup(root, group, { files })).rejects.toThrow(
      "does not match its pin",
    );

    writeFileSync(
      path.join(source, "tts", "paradee", "misaki.lex"),
      "tampered",
    );
    const other = bundleRoot();
    await expect(
      stageAospVoiceGroup(other, group, {
        files,
        local: readAospVoiceLocalSource(source),
      }),
    ).rejects.toThrow("does not match its pin");
    expect(existsSync(path.join(other, "tts", "paradee"))).toBe(false);
  });

  it("rejects corrupt existing bytes even when their size and local record agree", async () => {
    const root = bundleRoot();
    const data = Buffer.from("valid model");
    const file = published("vad", "vad", "vad/silero.gguf", data);
    const group = { dir: "vad", roles: ["vad"] } as const;
    await stageAospVoiceGroup(root, group, {
      ...allowedNetwork,
      files: [file],
      fetchImpl: (async () => new Response(data)) as typeof fetch,
    });
    expect(
      (await stageAospVoiceGroup(root, group, { files: [file] })).status,
    ).toBe("present");
    const corrupt = Buffer.alloc(data.length);
    writeFileSync(path.join(root, file.path), corrupt);
    writeFileSync(
      path.join(root, "vad", AOSP_VOICE_RECORD),
      JSON.stringify({
        schema: "eliza-mobile-voice-group-v1",
        dir: "vad",
        files: [{ ...file, sha256: sha(corrupt) }],
      }),
    );
    await expect(
      stageAospVoiceGroup(root, group, { files: [file] }),
    ).rejects.toThrow("does not match its pin");
    expect(readFileSync(path.join(root, file.path))).toEqual(corrupt);
    rmSync(path.join(root, file.path));
    await expect(
      stageAospVoiceGroup(root, group, { files: [file] }),
    ).rejects.toThrow();
  });

  it("rejects a local pin that disagrees with a published catalog pin", () => {
    const data = Buffer.from("vad");
    const file = published("vad", "vad", "vad/silero.gguf", data);
    expect(() =>
      expectedAospVoicePin(file, {
        dir: "/nowhere",
        pins: { vad: { sha256: "0".repeat(64), bytes: data.length } },
      }),
    ).toThrow("disagrees with the catalog");
  });
});
