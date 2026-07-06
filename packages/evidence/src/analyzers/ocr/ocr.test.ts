// OCR analyzers and engines. Tesseract runs against a rendered-text PNG when the
// binary is present and skips honestly (recording skipped-missing-tool) when it
// is not — the test asserts whichever path applies so CI without tesseract still
// exercises the degradation contract. The GPU `unlimited` client is tested
// against a local stub HTTP server that asserts the OpenAI-compatible request
// shape (model, temperature 0, image data URL) and returns a canned completion
// the client must parse; the real-model path is the gpu lane's live test.

import { rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { makeTmpDir, solidPng, textPng } from "../test-fixtures.ts";
import type { AnalyzerContext, AnalyzerInput } from "../types.ts";
import { TesseractOcrEngine, UnlimitedOcrEngine } from "./engines.ts";
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
      if (result.status === "skipped-missing-tool")
        expect(result.reason).toMatch(/tesseract/i);
    }
  });
});

describe("ocr.unlimited (GPU client against a stub server)", () => {
  let server: Server;
  let baseUrl: string;
  let lastBody: unknown;

  const start = () =>
    new Promise<void>((resolve) => {
      server = createServer((req, res) => {
        if (req.url === "/health") {
          res.writeHead(200).end("ok");
          return;
        }
        if (req.url === "/v1/chat/completions" && req.method === "POST") {
          let raw = "";
          req.on("data", (c) => {
            raw += c;
          });
          req.on("end", () => {
            lastBody = JSON.parse(raw);
            res.writeHead(200, { "content-type": "application/json" }).end(
              JSON.stringify({
                choices: [
                  { message: { content: "# Screen\nSign in to Eliza" } },
                ],
              }),
            );
          });
          return;
        }
        res.writeHead(404).end();
      });
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });

  afterAll(() => {
    server?.close();
  });

  it("is unavailable when the endpoint is unset", async () => {
    const engine = new UnlimitedOcrEngine({ baseUrl: undefined });
    const availability = await engine.available();
    expect(availability.available).toBe(false);
    if (!availability.available)
      expect(availability.reason).toMatch(/ELIZA_GPU_VISION_URL/);
  });

  it("reports available when health returns 200 and parses a completion", async () => {
    await start();
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

    // The request must be OpenAI-compatible: model, temperature 0, and an
    // image_url content part carrying a base64 data URL.
    const body = lastBody as {
      model: string;
      temperature: number;
      messages: { content: { type: string; image_url?: { url: string } }[] }[];
    };
    expect(body.model).toBe("unlimited-ocr");
    expect(body.temperature).toBe(0);
    const parts = body.messages[0].content;
    const image = parts.find((p) => p.type === "image_url");
    expect(image?.image_url?.url).toMatch(/^data:image\/png;base64,/);
  });

  it("is unavailable (not throwing) when the host is unreachable", async () => {
    // Port 1 is not listening; available() must degrade, not throw.
    const engine = new UnlimitedOcrEngine({ baseUrl: "http://127.0.0.1:1" });
    const availability = await engine.available();
    expect(availability.available).toBe(false);
  });
});
