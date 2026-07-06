// OCR analyzers and engines. Tesseract runs against a rendered-text PNG when the
// binary is present and skips honestly (recording skipped-missing-tool) when it
// is not — the test asserts whichever path applies so CI without tesseract still
// exercises the degradation contract. The GPU `unlimited` client is tested
// against local stub HTTP servers that assert the OpenAI-compatible request
// shape (model, temperature 0, the pinned OCR prompt, image data URL), the
// base-path-preserving URL joining, and serve.json endpoint discovery; a drift
// guard imports the real scripts/gpu-vision/lib.mjs and pins the prompt to it.
// The apple-vision engine is driven end-to-end through its real subprocess
// protocol with fake node helpers (ok:false, timeout, garbage output), so the
// "helper failure must never become an empty ran transcript" contract is proven
// without a swift toolchain.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTmpDir, solidPng, textPng } from "../test-fixtures.ts";
import type { AnalyzerContext, AnalyzerInput } from "../types.ts";
import {
  AppleVisionOcrEngine,
  parseGroundingDecorations,
  TesseractOcrEngine,
  UNLIMITED_OCR_PROMPT,
  UnlimitedOcrEngine,
} from "./engines.ts";
import { makeOcrAnalyzer, ocrTesseractAnalyzer } from "./ocr.ts";

const dir = makeTmpDir();
const ctx: AnalyzerContext = { tier: "cpu" };
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const inputFor = (absolutePath: string): AnalyzerInput => ({
  entry: {
    path: "visual/x/img.png",
    sha256: "0".repeat(64),
    bytes: 0,
    kind: "screenshot",
    source: "test",
    producedBy: "test",
    createdAt: new Date().toISOString(),
  },
  absolutePath,
});

describe("ocr.tesseract", () => {
  it("reads rendered text, or skips honestly when tesseract is absent", async () => {
    const png = await textPng(join(dir, "hello.png"), "EVIDENCE");
    const availability = await new TesseractOcrEngine().available();
    const result = await ocrTesseractAnalyzer.analyze(inputFor(png), ctx);
    if (availability.available) {
      expect(result.status).toBe("ran");
      if (result.status !== "ran") return;
      const data = result.data as { text: string; engine: string };
      expect(data.engine).toBe("tesseract");
      // Tesseract on a clean render should recover the word (case-insensitive).
      expect(data.text.toUpperCase()).toContain("EVIDENCE");
    } else {
      expect(result.status).toBe("skipped-missing-tool");
      if (result.status === "skipped-missing-tool") {
        expect(result.reason).toMatch(/tesseract/i);
      }
    }
  });

  it("reads rendered text from a long artifact path", async () => {
    const availability = await new TesseractOcrEngine().available();
    if (!availability.available) {
      expect(availability.reason).toMatch(/tesseract/i);
      return;
    }

    const longDir = join(
      dir,
      "video",
      "keyframes",
      "video-features-send-message-mp4",
      "nested-artifact-path-that-used-to-trip-leptonica",
    );
    mkdirSync(longDir, { recursive: true });
    const png = await textPng(join(longDir, "000-first.png"), "LONGPATH");
    const result = await ocrTesseractAnalyzer.analyze(inputFor(png), ctx);
    expect(result.status).toBe("ran");
    if (result.status !== "ran") return;
    const data = result.data as { text: string };
    expect(data.text.toUpperCase()).toContain("LONGPATH");
  });
});

describe("UNLIMITED_OCR_PROMPT drift guard", () => {
  it("is byte-identical to scripts/gpu-vision/lib.mjs OCR_PROMPT", async () => {
    // Import the real service module so the two prompt pins can never drift
    // silently — a change to either side fails here until both move together.
    const libUrl = new URL(
      "../../../../../scripts/gpu-vision/lib.mjs",
      import.meta.url,
    );
    const lib = (await import(libUrl.href)) as { OCR_PROMPT: string };
    expect(lib.OCR_PROMPT).toBe(UNLIMITED_OCR_PROMPT);
  });
});

describe("parseGroundingDecorations", () => {
  it("splits `title [x1,y1,x2,y2]` lines into cleaned text plus regions", () => {
    const raw =
      "Sign in to Eliza [12, 24, 300, 60]\nWelcome back\nSubmit [40,200,120,240]";
    const { text, regions } = parseGroundingDecorations(raw);
    expect(text).toBe("Sign in to Eliza\nWelcome back\nSubmit");
    expect(regions).toEqual([
      { text: "Sign in to Eliza", box: [12, 24, 300, 60] },
      { text: "Submit", box: [40, 200, 120, 240] },
    ]);
  });

  it("keeps a coordinate-only decoration as a region without polluting the text", () => {
    const { text, regions } = parseGroundingDecorations("[0,0,64,64]\nBody");
    expect(text).toBe("Body");
    expect(regions).toEqual([{ text: "", box: [0, 0, 64, 64] }]);
  });

  it("passes through lines whose bbox is invalid instead of fabricating a region", () => {
    // x2 < x1 and an implausibly large coordinate are not decorations.
    const inverted = "Header [300,10,12,60]";
    const huge = `Header [1,1,${"9".repeat(20)},5]`;
    for (const raw of [inverted, huge]) {
      const { text, regions } = parseGroundingDecorations(raw);
      expect(text).toBe(raw);
      expect(regions).toEqual([]);
    }
  });

  it("leaves undecorated markdown untouched", () => {
    const raw = "# Screen\nSign in to Eliza";
    expect(parseGroundingDecorations(raw)).toEqual({
      text: raw,
      regions: [],
    });
  });
});

/** Stub llama-server: /health + /v1/chat/completions under an optional path prefix. */
function startStub(options: { prefix?: string; content: () => string }) {
  const requests: { url: string; body: unknown }[] = [];
  const prefix = options.prefix ?? "";
  const server = createServer((req, res) => {
    if (req.url === `${prefix}/health`) {
      res.writeHead(200).end("ok");
      return;
    }
    if (req.url === `${prefix}/v1/chat/completions` && req.method === "POST") {
      let raw = "";
      req.on("data", (c) => {
        raw += c;
      });
      req.on("end", () => {
        requests.push({ url: req.url as string, body: JSON.parse(raw) });
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            choices: [{ message: { content: options.content() } }],
          }),
        );
      });
      return;
    }
    res.writeHead(404).end();
  });
  const started = new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
  return { server, started, requests };
}

describe("ocr.unlimited (GPU client against a stub server)", () => {
  let server: Server;
  let baseUrl: string;
  let port: number;
  let content = "# Screen\nSign in to Eliza";
  const stub = startStub({ content: () => content });

  beforeAll(async () => {
    server = stub.server;
    baseUrl = await stub.started;
    port = Number(new URL(baseUrl).port);
  });

  afterAll(() => {
    server?.close();
  });

  it("is unavailable when the endpoint is explicitly unset", async () => {
    const engine = new UnlimitedOcrEngine({ baseUrl: undefined });
    const availability = await engine.available();
    expect(availability.available).toBe(false);
    if (!availability.available)
      expect(availability.reason).toMatch(/ELIZA_GPU_VISION_URL/);
  });

  it("lets an explicit unset override ELIZA_GPU_VISION_URL", async () => {
    const previous = process.env.ELIZA_GPU_VISION_URL;
    process.env.ELIZA_GPU_VISION_URL = "http://127.0.0.1:9";
    try {
      const engine = new UnlimitedOcrEngine({ baseUrl: undefined });
      const availability = await engine.available();
      expect(availability.available).toBe(false);
      if (!availability.available)
        expect(availability.reason).toMatch(/ELIZA_GPU_VISION_URL/);
    } finally {
      if (previous === undefined) {
        delete process.env.ELIZA_GPU_VISION_URL;
      } else {
        process.env.ELIZA_GPU_VISION_URL = previous;
      }
    }
  });

  it("sends the pinned prompt and parses a completion", async () => {
    content = "# Screen\nSign in to Eliza";
    const engine = new UnlimitedOcrEngine({ baseUrl, model: "unlimited-ocr" });
    expect((await engine.available()).available).toBe(true);

    const png = await solidPng(join(dir, "u.png"), [10, 10, 10]);
    const analyzer = makeOcrAnalyzer(engine, "gpu");
    // Run at gpu tier so the analyzer executes rather than skipping-tier.
    const result = await analyzer.analyze(inputFor(png), { tier: "gpu" });
    expect(result.status).toBe("ran");
    if (result.status !== "ran") return;
    const data = result.data as { text: string; engine: string };
    expect(data.engine).toBe("unlimited");
    expect(data.text).toContain("Sign in to Eliza");

    // The request must be OpenAI-compatible: model, temperature 0, the pinned
    // service prompt, and an image_url content part carrying a base64 data URL.
    const body = stub.requests[stub.requests.length - 1].body as {
      model: string;
      temperature: number;
      messages: {
        content: { type: string; text?: string; image_url?: { url: string } }[];
      }[];
    };
    expect(body.model).toBe("unlimited-ocr");
    expect(body.temperature).toBe(0);
    const parts = body.messages[0].content;
    expect(parts.find((p) => p.type === "text")?.text).toBe(
      UNLIMITED_OCR_PROMPT,
    );
    const image = parts.find((p) => p.type === "image_url");
    expect(image?.image_url?.url).toMatch(/^data:image\/png;base64,/);
  });

  it("strips grounding decorations into structured regions", async () => {
    content = "Sign in to Eliza [12,24,300,60]\nWelcome back";
    const engine = new UnlimitedOcrEngine({ baseUrl });
    const png = await solidPng(join(dir, "g.png"), [10, 10, 10]);
    const analyzer = makeOcrAnalyzer(engine, "gpu");
    const result = await analyzer.analyze(inputFor(png), { tier: "gpu" });
    expect(result.status).toBe("ran");
    if (result.status !== "ran") return;
    const data = result.data as {
      text: string;
      regions: { text: string; box: number[] }[] | null;
    };
    // Text comparison sees clean text; coordinates live in structured regions.
    expect(data.text).toBe("Sign in to Eliza\nWelcome back");
    expect(data.regions).toEqual([
      { text: "Sign in to Eliza", box: [12, 24, 300, 60] },
    ]);
  });

  it("preserves a base URL path prefix when joining request paths", async () => {
    const prefixed = startStub({
      prefix: "/vision",
      content: () => "prefixed ok",
    });
    const prefixedBase = await prefixed.started;
    try {
      const engine = new UnlimitedOcrEngine({
        baseUrl: `${prefixedBase}/vision`,
      });
      expect((await engine.available()).available).toBe(true);
      const png = await solidPng(join(dir, "p.png"), [10, 10, 10]);
      const { text } = await engine.recognize(png);
      expect(text).toBe("prefixed ok");
      expect(prefixed.requests[0].url).toBe("/vision/v1/chat/completions");
    } finally {
      prefixed.server.close();
    }
  });

  it("is unavailable (not throwing) when the host is unreachable", async () => {
    // Port 1 is not listening; available() must degrade, not throw.
    const engine = new UnlimitedOcrEngine({ baseUrl: "http://127.0.0.1:1" });
    const availability = await engine.available();
    expect(availability.available).toBe(false);
  });

  describe("serve.json endpoint discovery", () => {
    // Discovery only applies when neither the option nor the env var is set;
    // shield the tests from a real dev-machine service.
    let savedUrl: string | undefined;
    beforeAll(() => {
      savedUrl = process.env.ELIZA_GPU_VISION_URL;
      delete process.env.ELIZA_GPU_VISION_URL;
    });
    afterAll(() => {
      if (savedUrl !== undefined) process.env.ELIZA_GPU_VISION_URL = savedUrl;
    });

    it("discovers the endpoint from serve.mjs's serve.json record", async () => {
      content = "discovered via serve.json";
      const statePath = join(dir, "serve.json");
      writeFileSync(
        statePath,
        `${JSON.stringify({ ocr: { port, pid: 12345, model: "Unlimited-OCR-Q4_K_M.gguf" } })}\n`,
      );
      const engine = new UnlimitedOcrEngine({ serveStatePath: statePath });
      expect((await engine.available()).available).toBe(true);
      const png = await solidPng(join(dir, "d.png"), [10, 10, 10]);
      const { text } = await engine.recognize(png);
      expect(text).toBe("discovered via serve.json");
    });

    it("is unavailable with a pointer at serve.mjs when no serve.json exists", async () => {
      const engine = new UnlimitedOcrEngine({
        serveStatePath: join(dir, "missing", "serve.json"),
      });
      const availability = await engine.available();
      expect(availability.available).toBe(false);
      if (!availability.available) {
        expect(availability.reason).toMatch(/serve\.json/);
        expect(availability.reason).toMatch(/serve\.mjs/);
      }
    });

    it("treats a corrupt serve.json as endpoint-unknown, never a fabricated endpoint", async () => {
      const statePath = join(dir, "corrupt-serve.json");
      writeFileSync(statePath, "{not json");
      const engine = new UnlimitedOcrEngine({ serveStatePath: statePath });
      const availability = await engine.available();
      expect(availability.available).toBe(false);
      if (!availability.available)
        expect(availability.reason).toMatch(/not valid JSON/);
    });

    it("rejects a serve.json ocr entry with an invalid port", async () => {
      const statePath = join(dir, "badport-serve.json");
      writeFileSync(statePath, JSON.stringify({ ocr: { port: "31338" } }));
      const engine = new UnlimitedOcrEngine({ serveStatePath: statePath });
      const availability = await engine.available();
      expect(availability.available).toBe(false);
      if (!availability.available)
        expect(availability.reason).toMatch(/invalid port/);
    });
  });
});

describe("apple-vision engine (fake helper subprocess)", () => {
  // The engine's stdin→NDJSON protocol is exercised with real child processes
  // running node scripts that mimic the swift helper's contract.
  const helperDir = join(dir, "apple-vision-helpers");
  mkdirSync(helperDir, { recursive: true });
  const writeHelper = (name: string, source: string): string => {
    const file = join(helperDir, name);
    writeFileSync(file, source);
    return file;
  };
  const engineFor = (scriptPath: string, timeoutMs?: number) =>
    new AppleVisionOcrEngine({
      scriptPath,
      command: process.execPath,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });

  it("throws a typed failure on ok:false instead of returning an empty transcript", async () => {
    const helper = writeHelper(
      "ok-false.mjs",
      `process.stdin.on("data", () => {
  process.stdout.write(JSON.stringify({ path: "x", ok: false, text: "", lines: [], words: 0, meanConfidence: 0 }) + "\\n");
  process.exit(0);
});\n`,
    );
    await expect(
      engineFor(helper).recognize(join(dir, "unreadable.png")),
    ).rejects.toMatchObject({
      name: "EvidenceError",
      code: "APPLE_VISION_OCR_FAILED",
      message: expect.stringMatching(/ok:false/),
    });
  });

  it("returns text and confidence from an ok:true record", async () => {
    const helper = writeHelper(
      "ok-true.mjs",
      `process.stdin.on("data", (chunk) => {
  const path = String(chunk).trim();
  process.stdout.write(JSON.stringify({ path, ok: true, text: "HELLO\\nWORLD", lines: ["HELLO", "WORLD"], words: 2, meanConfidence: 0.93 }) + "\\n");
  process.exit(0);
});\n`,
    );
    const recognition = await engineFor(helper).recognize(join(dir, "a.png"));
    expect(recognition.text).toBe("HELLO\nWORLD");
    expect(recognition.confidence).toBeCloseTo(0.93);
  });

  it("kills and fails a hung helper at the spawn timeout", async () => {
    const helper = writeHelper(
      "hang.mjs",
      `process.stdin.resume();\nsetInterval(() => {}, 1000);\n`,
    );
    await expect(
      engineFor(helper, 400).recognize(join(dir, "a.png")),
    ).rejects.toMatchObject({
      code: "APPLE_VISION_OCR_TIMEOUT",
      message: expect.stringMatching(/timed out after 400ms/),
    });
  });

  it("fails on unparseable helper output", async () => {
    const helper = writeHelper(
      "garbage.mjs",
      `process.stdin.on("data", () => {
  process.stdout.write("this is not ndjson\\n");
  process.exit(0);
});\n`,
    );
    await expect(
      engineFor(helper).recognize(join(dir, "a.png")),
    ).rejects.toMatchObject({
      code: "APPLE_VISION_OCR_FAILED",
      message: expect.stringMatching(/unparseable/),
    });
  });

  it("fails on a record missing the ok/text contract", async () => {
    const helper = writeHelper(
      "bad-shape.mjs",
      `process.stdin.on("data", () => {
  process.stdout.write(JSON.stringify({ path: "x", noOk: true }) + "\\n");
  process.exit(0);
});\n`,
    );
    await expect(
      engineFor(helper).recognize(join(dir, "a.png")),
    ).rejects.toMatchObject({
      code: "APPLE_VISION_OCR_FAILED",
      message: expect.stringMatching(/missing ok\/text/),
    });
  });

  it("fails with stderr context when the helper exits non-zero", async () => {
    const helper = writeHelper(
      "crash.mjs",
      `process.stderr.write("vision exploded");\nprocess.exit(3);\n`,
    );
    await expect(
      engineFor(helper).recognize(join(dir, "a.png")),
    ).rejects.toMatchObject({
      code: "APPLE_VISION_OCR_FAILED",
      message: expect.stringMatching(/exited 3.*vision exploded/),
    });
  });
});
