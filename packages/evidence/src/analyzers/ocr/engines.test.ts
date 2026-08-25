/**
 * Engine-level coverage for the OCR backends, complementing `ocr.test.ts`
 * (which drives them through the analyzer layer). Everything here exercises
 * the real classes: tesseract availability probes and transcript
 * normalization run against real child-process fake binaries, apple-vision
 * availability branches are probed with injectable command/script paths, and
 * the unlimited client's error mapping, model resolution, MIME mapping, and
 * base-URL joining are driven through the constructor-documented `fetchImpl`
 * seam while asserting what the module itself derives.
 */

import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { makeTmpDir } from "../test-fixtures.ts";
import {
  AppleVisionOcrEngine,
  defaultServeStatePath,
  parseGroundingDecorations,
  TesseractOcrEngine,
  UnlimitedOcrEngine,
} from "./engines.ts";

const dir = makeTmpDir("evidence-ocr-engines-");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const writeExecutable = (name: string, source: string): string => {
  const file = join(dir, name);
  writeFileSync(file, source);
  chmodSync(file, 0o755);
  return file;
};

describe("TesseractOcrEngine availability probes", () => {
  it("reports available when the configured binary answers --version", async () => {
    const bin = writeExecutable("tess-ok.sh", "#!/bin/sh\nexit 0\n");
    const availability = await new TesseractOcrEngine(bin).available();
    expect(availability).toEqual({ available: true });
  });

  it("reports not-installed (ENOENT) with the binary path in the reason", async () => {
    const bin = join(dir, "no-such-tesseract");
    const availability = await new TesseractOcrEngine(bin).available();
    expect(availability.available).toBe(false);
    if (!availability.available)
      expect(availability.reason).toBe(`tesseract not installed (${bin})`);
  });

  it("surfaces a non-zero --version exit as a failed probe, not installed", async () => {
    const bin = writeExecutable(
      "tess-fail.sh",
      '#!/bin/sh\necho "boom" >&2\nexit 1\n',
    );
    const availability = await new TesseractOcrEngine(bin).available();
    expect(availability.available).toBe(false);
    if (!availability.available)
      expect(availability.reason).toMatch(/--version failed:.*boom/s);
  });
});

describe("TesseractOcrEngine.recognize transcript handling", () => {
  const image = join(dir, "scan.png");
  beforeAll(() => writeFileSync(image, "fake-image-bytes"));

  it("normalizes stdout: per-line trim, blank-line removal, newline join", async () => {
    const bin = writeExecutable(
      "tess-print.sh",
      "#!/bin/sh\nprintf '  Line one  \\n\\n\\tLine two\\t\\n   \\nLine three\\n'\n",
    );
    const recognition = await new TesseractOcrEngine(bin).recognize(image);
    expect(recognition).toEqual({ text: "Line one\nLine two\nLine three" });
  });

  it("returns an empty transcript when the binary legitimately emits nothing", async () => {
    const bin = writeExecutable("tess-silent.sh", "#!/bin/sh\nexit 0\n");
    const recognition = await new TesseractOcrEngine(bin).recognize(image);
    expect(recognition).toEqual({ text: "" });
  });

  it("stages the input under a short filename preserving its extension", async () => {
    // The fake binary echoes its first argument — the staged path — so the
    // test observes the staging contract (basename input.<ext>) directly.
    const bin = writeExecutable(
      "tess-echo-arg.sh",
      "#!/bin/sh\nprintf '%s\\n' \"$1\"\n",
    );
    const jpg = join(dir, "deep", "artifact.jpg");
    mkdirSync(join(dir, "deep"), { recursive: true });
    writeFileSync(jpg, "jpg-bytes");
    const recognition = await new TesseractOcrEngine(bin).recognize(jpg);
    const stagedPath = recognition.text;
    expect(stagedPath.endsWith(`input.jpg`)).toBe(true);
    expect(stagedPath.length).toBeLessThan(jpg.length);

    // Staging copies the real bytes: have the binary cat the staged file.
    const catBin = writeExecutable("tess-cat.sh", '#!/bin/sh\ncat "$1"\n');
    const echoed = await new TesseractOcrEngine(catBin).recognize(jpg);
    expect(echoed.text).toBe("jpg-bytes");
  });
});

describe("AppleVisionOcrEngine availability probes", () => {
  const onDarwin = process.platform === "darwin";

  it("rejects a missing helper script with its resolved path", async () => {
    const missingScript = join(dir, "no-such-helper.swift");
    const availability = await new AppleVisionOcrEngine({
      scriptPath: missingScript,
    }).available();
    expect(availability.available).toBe(false);
    if (!availability.available) {
      if (onDarwin) {
        expect(availability.reason).toBe(
          `apple-vision helper not found: ${missingScript}`,
        );
      } else {
        expect(availability.reason).toMatch(/requires macOS/);
      }
    }
  });

  it("degrades to unavailable when the swift command fails --version", async () => {
    const dummyScript = join(dir, "dummy.swift");
    writeFileSync(dummyScript, "// placeholder\n");
    // A real executable that exits non-zero for --version (this macOS image
    // ships no /bin/false, so the failure is produced by a script instead).
    const swiftFail = writeExecutable(
      "swift-fail.sh",
      '#!/bin/sh\necho "toolchain broken" >&2\nexit 1\n',
    );
    const availability = await new AppleVisionOcrEngine({
      scriptPath: dummyScript,
      command: swiftFail,
    }).available();
    expect(availability.available).toBe(false);
    if (!availability.available) {
      if (onDarwin) {
        expect(availability.reason).toMatch(
          /swift --version failed:.*toolchain broken/s,
        );
      } else {
        expect(availability.reason).toMatch(/requires macOS/);
      }
    }
  });

  it("reports a missing swift toolchain (ENOENT) distinctly from a failing run", async () => {
    const dummyScript = join(dir, "dummy2.swift");
    writeFileSync(dummyScript, "// placeholder\n");
    const availability = await new AppleVisionOcrEngine({
      scriptPath: dummyScript,
      command: join(dir, "no-such-swift"),
    }).available();
    expect(availability.available).toBe(false);
    if (!availability.available) {
      if (onDarwin) {
        expect(availability.reason).toBe("swift toolchain not installed");
      } else {
        expect(availability.reason).toMatch(/requires macOS/);
      }
    }
  });

  it("confirms availability when script exists and the command probes clean", async () => {
    const dummyScript = join(dir, "dummy3.swift");
    writeFileSync(dummyScript, "// placeholder\n");
    const availability = await new AppleVisionOcrEngine({
      scriptPath: dummyScript,
      command: "/usr/bin/true",
    }).available();
    if (onDarwin) {
      expect(availability).toEqual({ available: true });
    } else {
      expect(availability.available).toBe(false);
    }
  });
});

describe("UnlimitedOcrEngine direct recognize failures", () => {
  it("throws the typed UNCONFIGURED error when called without any endpoint", async () => {
    const engine = new UnlimitedOcrEngine({
      baseUrl: undefined,
      serveStatePath: join(dir, "unconfigured", "serve.json"),
    });
    await expect(engine.recognize(join(dir, "x.png"))).rejects.toMatchObject({
      name: "EvidenceError",
      code: "GPU_VISION_UNCONFIGURED",
      message: expect.stringMatching(/explicitly unset/),
    });
  });

  it("maps a non-OK completion response to GPU_VISION_HTTP_ERROR with status context", async () => {
    const image = join(dir, "http-error.png");
    writeFileSync(image, "png-bytes");
    const engine = new UnlimitedOcrEngine({
      baseUrl: "http://127.0.0.1:9",
      fetchImpl: async () => ({
        ok: false,
        status: 502,
        json: async () => ({}),
      }),
    });
    await expect(engine.recognize(image)).rejects.toMatchObject({
      name: "EvidenceError",
      code: "GPU_VISION_HTTP_ERROR",
      message: expect.stringMatching(/chat\/completions 502/),
      context: { status: 502, baseUrl: "http://127.0.0.1:9" },
    });
  });

  it("rejects a 200 response whose body lacks choices[0].message.content", async () => {
    const image = join(dir, "bad-body.png");
    writeFileSync(image, "png-bytes");
    const engine = new UnlimitedOcrEngine({
      baseUrl: "http://127.0.0.1:9",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: {} }] }),
      }),
    });
    await expect(engine.recognize(image)).rejects.toMatchObject({
      name: "EvidenceError",
      code: "GPU_VISION_BAD_RESPONSE",
    });
  });

  it("resolves the model from ELIZA_GPU_VISION_MODEL before the default", async () => {
    const image = join(dir, "model.png");
    writeFileSync(image, "png-bytes");
    const savedModel = process.env.ELIZA_GPU_VISION_MODEL;
    process.env.ELIZA_GPU_VISION_MODEL = "env-selected-model";
    try {
      const seen: unknown[] = [];
      const engine = new UnlimitedOcrEngine({
        baseUrl: "http://127.0.0.1:9",
        fetchImpl: async (_input, init) => {
          seen.push(JSON.parse(init.body ?? "{}"));
          return {
            ok: true,
            status: 200,
            json: async () => ({
              choices: [{ message: { content: "ok" } }],
            }),
          };
        },
      });
      await engine.recognize(image);
      expect((seen[0] as { model: string }).model).toBe("env-selected-model");

      delete process.env.ELIZA_GPU_VISION_MODEL;
      const fallback = new UnlimitedOcrEngine({
        baseUrl: "http://127.0.0.1:9",
        fetchImpl: async (_input, init) => {
          seen.push(JSON.parse(init.body ?? "{}"));
          return {
            ok: true,
            status: 200,
            json: async () => ({
              choices: [{ message: { content: "ok" } }],
            }),
          };
        },
      });
      await fallback.recognize(image);
      expect((seen[1] as { model: string }).model).toBe("unlimited-ocr");
    } finally {
      if (savedModel === undefined) {
        delete process.env.ELIZA_GPU_VISION_MODEL;
      } else {
        process.env.ELIZA_GPU_VISION_MODEL = savedModel;
      }
    }
  });

  it("maps file extensions to data-URL MIME types with a PNG default", async () => {
    const cases: { file: string; mime: string }[] = [
      { file: "photo.jpg", mime: "image/jpeg" },
      { file: "picture.webp", mime: "image/webp" },
      { file: "unknown.bmp", mime: "image/png" },
    ];
    for (const { file, mime } of cases) {
      const image = join(dir, file);
      writeFileSync(image, `${mime}-bytes`);
      let dataUrl = "";
      const engine = new UnlimitedOcrEngine({
        baseUrl: "http://127.0.0.1:9",
        fetchImpl: async (_input, init) => {
          const body = JSON.parse(init.body ?? "{}") as {
            messages: {
              content: { type: string; image_url?: { url: string } }[];
            }[];
          };
          dataUrl =
            body.messages[0].content.find((p) => p.type === "image_url")
              ?.image_url?.url ?? "";
          return {
            ok: true,
            status: 200,
            json: async () => ({
              choices: [{ message: { content: "ok" } }],
            }),
          };
        },
      });
      await engine.recognize(image);
      expect(dataUrl.startsWith(`data:${mime};base64,`)).toBe(true);
    }
  });

  it("keeps a trailing-slash base path prefix when appending request paths", async () => {
    const image = join(dir, "join.png");
    writeFileSync(image, "png-bytes");
    const urls: string[] = [];
    const engine = new UnlimitedOcrEngine({
      baseUrl: "http://127.0.0.1:9/vision/",
      fetchImpl: async (input) => {
        urls.push(String(input));
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ message: { content: "joined" } }],
          }),
        };
      },
    });
    await engine.recognize(image);
    expect(urls).toHaveLength(1);
    expect(new URL(urls[0]).pathname).toBe("/vision/v1/chat/completions");
  });
});

describe("parseGroundingDecorations edge branches", () => {
  it("passes through a ]-terminated line that has no [ bracket", () => {
    const raw = "array literal ends here]";
    expect(parseGroundingDecorations(raw)).toEqual({
      text: raw,
      regions: [],
    });
  });

  it("rejects a bracketed tail whose bbox has the wrong arity", () => {
    const raw = "Marker [1,2,3]";
    expect(parseGroundingDecorations(raw)).toEqual({ text: raw, regions: [] });
  });

  it("rejects negative coordinates instead of fabricating a region", () => {
    const raw = "Panel [5,5,-3,9]";
    expect(parseGroundingDecorations(raw)).toEqual({ text: raw, regions: [] });
  });

  it("accepts a degenerate zero-size box (x2==x1, y2==y1)", () => {
    const { text, regions } = parseGroundingDecorations("Dot [4,4,4,4]");
    expect(text).toBe("Dot");
    expect(regions).toEqual([{ text: "Dot", box: [4, 4, 4, 4] }]);
  });

  it("anchors on the last [ so decorated text may itself contain brackets", () => {
    const { text, regions } = parseGroundingDecorations(
      "Note [see appendix] [10,20,30,40]",
    );
    expect(text).toBe("Note [see appendix]");
    expect(regions).toEqual([
      { text: "Note [see appendix]", box: [10, 20, 30, 40] },
    ]);
  });

  it("yields an empty transcript for consecutive coordinate-only decorations", () => {
    const { text, regions } = parseGroundingDecorations("[0,0,1,1]\n[2,2,3,3]");
    expect(text).toBe("");
    expect(regions).toEqual([
      { text: "", box: [0, 0, 1, 1] },
      { text: "", box: [2, 2, 3, 3] },
    ]);
  });

  it("mixes valid regions with verbatim invalid lines in order", () => {
    const raw = "Good [1,2,3,4]\nBad [9,9]\nTail [0,0,0,0]";
    const { text, regions } = parseGroundingDecorations(raw);
    // Valid decorations keep their cleaned text in the transcript; only the
    // invalid line passes through verbatim.
    expect(text).toBe("Good\nBad [9,9]\nTail");
    expect(regions).toEqual([
      { text: "Good", box: [1, 2, 3, 4] },
      { text: "Tail", box: [0, 0, 0, 0] },
    ]);
  });
});

describe("defaultServeStatePath", () => {
  const savedCache = process.env.ELIZA_GPU_VISION_CACHE;

  afterEach(() => {
    if (savedCache === undefined) {
      delete process.env.ELIZA_GPU_VISION_CACHE;
    } else {
      process.env.ELIZA_GPU_VISION_CACHE = savedCache;
    }
  });

  it("prefers the ELIZA_GPU_VISION_CACHE override directory", () => {
    process.env.ELIZA_GPU_VISION_CACHE = "/tmp/custom-gpu-cache";
    expect(defaultServeStatePath()).toBe("/tmp/custom-gpu-cache/serve.json");
  });

  it("falls back to the per-user cache when the override is blank", () => {
    process.env.ELIZA_GPU_VISION_CACHE = "   ";
    expect(defaultServeStatePath()).toContain(
      join(".cache", "eliza", "gpu-vision", "serve.json"),
    );
  });

  it("uses the per-user cache root when no override is set", () => {
    delete process.env.ELIZA_GPU_VISION_CACHE;
    const resolved = defaultServeStatePath();
    expect(resolved.startsWith("/")).toBe(true);
    expect(
      resolved.endsWith(join(".cache", "eliza", "gpu-vision", "serve.json")),
    ).toBe(true);
  });
});
