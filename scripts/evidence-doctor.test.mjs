/**
 * Verifies doctor classification, executable probes, redaction, normalized
 * reporting, and strict CLI boundaries with deterministic capability fakes.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildOcrFixtureBmp,
  createDoctorReport,
  parseDoctorArgs,
  probeMediaPipeline,
  probePackagedOcr,
  probeSystemTesseract,
  runProbes,
  summarize,
} from "./evidence-doctor.mjs";
import { EVIDENCE_REQUIREMENTS } from "./evidence-install-tools.mjs";

const healthyMedia = async () => ({
  ffmpeg: { available: true, bin: "/tools/ffmpeg", source: "bundled" },
  ffprobe: { available: true, bin: "/tools/ffprobe", source: "bundled" },
});
const healthyOcr = async () => ({
  ok: true,
  detail: "tesseract.js createWorker is loadable",
});
const healthyPlaywright = async () => ({
  ok: true,
  detail: "Playwright Chromium 123 launched successfully",
});
const healthyMediaPipeline = async () => ({
  ok: true,
  detail: "media fixture passed",
});

describe("evidence toolchain doctor", () => {
  it("uses the installer catalog for every required baseline probe", async () => {
    const probes = await runProbes(
      {},
      {
        commandProbe: async () => null,
        mediaResolver: healthyMedia,
        mediaPipelineProbe: healthyMediaPipeline,
        ocrProbe: healthyOcr,
        playwrightProbe: healthyPlaywright,
        pathExists: () => false,
      },
    );
    const requiredIds = probes
      .filter(({ required }) => required)
      .map(({ id }) => id);
    const catalogIds = Object.values(EVIDENCE_REQUIREMENTS)
      .filter(({ requiredByDefault }) => requiredByDefault)
      .map(({ id }) => id);
    assert.deepEqual(requiredIds, catalogIds);
    for (const probe of probes) {
      assert.equal(typeof probe.ok, "boolean");
      assert.equal(typeof probe.required, "boolean");
      assert.ok(probe.fix.length > 0, `${probe.id} lacks a fix`);
    }
  });

  it("requires executable ffmpeg, ffprobe, packaged OCR, and launched Chromium", async () => {
    const probes = await runProbes(
      {},
      {
        commandProbe: async () => null,
        mediaResolver: async () => ({
          ffmpeg: { available: false, reason: "ffmpeg binary failed" },
          ffprobe: { available: false, reason: "ffprobe binary failed" },
        }),
        mediaPipelineProbe: async () => ({
          ok: false,
          detail: "media fixture failed",
        }),
        ocrProbe: async () => ({
          ok: false,
          detail: "tesseract.js is not loadable",
        }),
        systemOcrProbe: async () => ({
          ok: false,
          detail:
            "system tesseract at tesseract is unavailable or failed on the bundled fixture",
        }),
        playwrightProbe: async () => ({
          ok: false,
          detail: "Chromium launch failed",
        }),
        pathExists: () => true,
      },
    );
    assert.deepEqual(
      summarize(probes).requiredMissing.map(({ id }) => id),
      ["ocr", "ffmpeg", "ffprobe", "playwright-browsers"],
    );
    assert.equal(
      probes.find(({ id }) => id === "playwright-browsers").ok,
      false,
      "an existing cache hint must not replace a real Chromium launch",
    );
  });

  it("accepts system Tesseract only when it recognizes the fixture behaviorally", async () => {
    const calls = [];
    const systemOcrProbe = async ({ bin }) => {
      calls.push({ bin });
      return {
        ok: true,
        detail: `system tesseract at ${bin} recognized the bundled ELIZA fixture`,
      };
    };
    const probes = await runProbes(
      { ELIZA_TESSERACT_BIN: "/tools/tesseract" },
      {
        commandProbe: async () => null,
        mediaResolver: healthyMedia,
        mediaPipelineProbe: healthyMediaPipeline,
        ocrProbe: async () => ({
          ok: false,
          detail: "tesseract.js is not loadable",
        }),
        systemOcrProbe,
        playwrightProbe: healthyPlaywright,
        pathExists: () => false,
      },
    );
    const ocr = probes.find(({ id }) => id === "ocr");
    assert.equal(ocr.ok, true);
    assert.match(
      ocr.detail,
      /recognized the bundled ELIZA fixture \(system fallback\)/,
    );
    assert.deepEqual(calls, [{ bin: "/tools/tesseract" }]);
  });

  it("rejects a system tesseract that answers --version but fails the fixture", async () => {
    const probes = await runProbes(
      {},
      {
        commandProbe: async (bin) =>
          bin === "tesseract" ? "tesseract 5.5.0" : null,
        mediaResolver: healthyMedia,
        mediaPipelineProbe: healthyMediaPipeline,
        ocrProbe: async () => ({
          ok: false,
          detail: "tesseract.js could not recognize the bundled fixture",
        }),
        systemOcrProbe: async ({ bin }) => ({
          ok: false,
          detail: `system tesseract at ${bin} did not recognize the bundled fixture`,
        }),
        playwrightProbe: healthyPlaywright,
        pathExists: () => false,
      },
    );
    const ocr = probes.find(({ id }) => id === "ocr");
    assert.equal(ocr.ok, false);
    assert.match(ocr.detail, /tesseract\.js could not recognize/);
    assert.match(ocr.detail, /system tesseract at tesseract did not recognize/);
  });

  it("probes the system binary with the evidence engine's exact invocation", async () => {
    const calls = [];
    const result = await probeSystemTesseract({
      bin: "/tools/tesseract",
      run: async (bin, args, options) => {
        const { readFileSync } = await import("node:fs");
        calls.push({
          bin,
          args,
          timeout: options.timeout,
          fixtureMatchesGenerator: readFileSync(args[0]).equals(
            buildOcrFixtureBmp(),
          ),
        });
        return { stdout: "ELIZA\n" };
      },
    });
    assert.equal(result.ok, true);
    assert.match(result.detail, /recognized the bundled ELIZA fixture/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].bin, "/tools/tesseract");
    assert.match(calls[0].args[0], /eliza-ocr-doctor-system-.*fixture\.bmp$/);
    assert.deepEqual(calls[0].args.slice(1), ["-", "--psm", "8"]);
    assert.equal(calls[0].fixtureMatchesGenerator, true);
    assert.ok(calls[0].timeout > 0);

    const wrong = await probeSystemTesseract({
      bin: "/tools/tesseract",
      run: async () => ({ stdout: "SOMETHING ELSE" }),
    });
    assert.equal(wrong.ok, false);
    assert.match(wrong.detail, /did not recognize the bundled fixture/);

    const broken = await probeSystemTesseract({
      bin: "/missing/tesseract",
      run: async () => {
        throw new Error("ENOENT");
      },
    });
    assert.equal(broken.ok, false);
    assert.match(broken.detail, /unavailable or failed on the bundled fixture/);
  });

  it("reports GitHub CLI without probing credentials or repository permissions", async () => {
    const calls = [];
    const secretUrl = "https://secret-user:secret-pass@example.test/ocr";
    const commandProbe = async (bin, args) => {
      calls.push({ bin, args });
      return bin === "gh" && args[0] === "--version"
        ? "gh version 2.99.0"
        : null;
    };
    const probes = await runProbes(
      { ELIZA_GPU_VISION_URL: secretUrl },
      {
        platform: "win32",
        commandProbe,
        mediaResolver: healthyMedia,
        mediaPipelineProbe: healthyMediaPipeline,
        ocrProbe: healthyOcr,
        playwrightProbe: healthyPlaywright,
        pathExists: () => false,
      },
    );
    assert.equal(summarize(probes).ok, true);
    const github = probes.find((probe) => probe.id === "github-cli");
    assert.equal(github.required, false);
    assert.equal(github.ok, true);
    assert.deepEqual(
      calls.filter(({ bin }) => bin === "gh"),
      [{ bin: "gh", args: ["--version"] }],
    );
    const serialized = JSON.stringify(probes);
    assert.doesNotMatch(serialized, /secret-user|secret-pass/u);
    assert.match(
      probes.find(({ id }) => id === "gpu-vision-ocr").detail,
      /value hidden/,
    );
  });

  it("emits a normalized platform report with explicit missing sets", () => {
    const probes = [
      {
        id: "required",
        required: true,
        ok: false,
        detail: "missing",
        fix: "install",
      },
      {
        id: "optional",
        required: false,
        ok: false,
        detail: "missing",
        fix: "configure",
      },
    ];
    assert.deepEqual(
      createDoctorReport(probes, {
        platform: "linux",
        architecture: "x64",
        nodeVersion: "v24.15.0",
      }),
      {
        schemaVersion: 1,
        platform: {
          os: "linux",
          architecture: "x64",
          nodeVersion: "v24.15.0",
        },
        ok: false,
        requiredMissing: ["required"],
        optionalMissing: ["optional"],
        probes,
      },
    );
  });

  it("recognizes a generated bitmap through a real packaged-OCR worker contract", async () => {
    const calls = [];
    const result = await probePackagedOcr({
      loadTesseract: async () => ({
        PSM: { SINGLE_LINE: 7 },
        createWorker: async (language, mode, options) => {
          calls.push({
            operation: "create",
            language,
            mode,
            hasIsolatedCache: /eliza-ocr-doctor-/u.test(options.cachePath),
          });
          return {
            setParameters: async (parameters) => {
              calls.push({ operation: "configure", parameters });
            },
            recognize: async (fixture) => {
              calls.push({
                operation: "recognize",
                signature: fixture.subarray(0, 2).toString("ascii"),
                bytes: fixture.length,
              });
              return { data: { text: "ELIZA" } };
            },
            terminate: async () => {
              calls.push({ operation: "terminate" });
            },
          };
        },
      }),
    });
    assert.equal(result.ok, true);
    assert.match(result.detail, /recognized the bundled ELIZA fixture/);
    assert.deepEqual(calls[0], {
      operation: "create",
      language: "eng",
      mode: 1,
      hasIsolatedCache: true,
    });
    assert.equal(
      calls.find(({ operation }) => operation === "recognize").signature,
      "BM",
    );
    assert.ok(
      calls.find(({ operation }) => operation === "recognize").bytes > 1_000,
    );
    assert.equal(calls.at(-1).operation, "terminate");
  });

  it("rejects packaged OCR that cannot read the known fixture", async () => {
    const result = await probePackagedOcr({
      loadTesseract: async () => ({
        createWorker: async () => ({
          recognize: async () => ({ data: { text: "WRONG" } }),
          terminate: async () => {},
        }),
      }),
    });
    assert.equal(result.ok, false);
    assert.match(result.detail, /did not recognize/);
  });

  it("terminates a worker whose creation outlives the probe deadline", async () => {
    let terminated = false;
    const result = await probePackagedOcr({
      timeoutMs: 20,
      loadTesseract: async () => ({
        createWorker: () =>
          new Promise((resolve) => {
            setTimeout(
              () =>
                resolve({
                  terminate: async () => {
                    terminated = true;
                  },
                }),
              80,
            );
          }),
      }),
    });
    assert.equal(result.ok, false);
    // The late worker resolves after the probe returned; it must still be
    // terminated so its threads cannot keep the doctor process alive.
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(terminated, true);
  });

  it("keeps the probe result when worker teardown hangs past its deadline", async () => {
    const result = await probePackagedOcr({
      timeoutMs: 20,
      loadTesseract: async () => ({
        createWorker: async () => ({
          recognize: async () => ({ data: { text: "ELIZA" } }),
          terminate: () => new Promise(() => {}),
        }),
      }),
    });
    assert.equal(result.ok, true);
    assert.match(result.detail, /recognized the bundled ELIZA fixture/);
  });

  it("requires a real ffmpeg encode, ffprobe inspection, and ffmpeg decode", async () => {
    const calls = [];
    const result = await probeMediaPipeline(await healthyMedia(), {
      run: async (bin, args) => {
        calls.push({ bin, args });
        if (bin === "/tools/ffprobe") {
          return {
            stdout: JSON.stringify({
              streams: [{ codec_type: "video", width: 32, height: 32 }],
            }),
          };
        }
        const outputPath = args.at(-1);
        if (args.includes("lavfi")) {
          await writeFile(outputPath, "encoded fixture");
        } else {
          await writeFile(outputPath, Buffer.alloc(32 * 32 * 3));
        }
        return { stdout: "" };
      },
    });
    assert.equal(result.ok, true);
    assert.equal(calls.length, 3);
    assert.deepEqual(
      calls.map(({ bin }) => bin),
      ["/tools/ffmpeg", "/tools/ffprobe", "/tools/ffmpeg"],
    );
    assert.ok(calls[0].args.includes("lavfi"));
    assert.ok(calls[1].args.includes("stream=codec_type,width,height"));
    assert.ok(calls[2].args.includes("rawvideo"));
  });

  it("lets optional absences remain non-blocking", () => {
    const summary = summarize([
      { id: "required", required: true, ok: true },
      { id: "optional", required: false, ok: false },
    ]);
    assert.equal(summary.ok, true);
    assert.equal(summary.requiredMissing.length, 0);
    assert.equal(summary.optionalMissing.length, 1);
  });

  it("fails closed on unknown CLI options", () => {
    assert.deepEqual(parseDoctorArgs(["--json", "--strict"]), {
      help: false,
      json: true,
      strict: true,
    });
    assert.throws(
      () => parseDoctorArgs(["--strcit"]),
      /unknown argument: --strcit/,
    );
    assert.throws(
      () => parseDoctorArgs(["unexpected-position"]),
      /unknown argument: unexpected-position/,
    );
    assert.throws(
      () => parseDoctorArgs(["--require-github"]),
      /unknown argument: --require-github/,
    );

    const cli = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("./evidence-doctor.mjs", import.meta.url)),
        "--strcit",
      ],
      { encoding: "utf8" },
    );
    assert.equal(cli.status, 1);
    assert.match(cli.stderr, /evidence-doctor: unknown argument: --strcit/);
    assert.equal(cli.stdout, "");
  });

  it("rejects unsupported operating systems before probing", async () => {
    await assert.rejects(
      runProbes(
        {},
        {
          platform: "aix",
          mediaResolver: healthyMedia,
          mediaPipelineProbe: healthyMediaPipeline,
          ocrProbe: healthyOcr,
          playwrightProbe: healthyPlaywright,
        },
      ),
      /unsupported operating system/,
    );
  });
});
