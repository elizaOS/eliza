import { describe, expect, it } from "vitest";
import { createSseStream } from "../src/proxy/sse-rewrite.js";

describe("createSseStream", () => {
  it("buffers split reverse-map patterns across chunks", () => {
    const emitted: string[] = [];
    let finished = false;
    const stream = createSseStream(
      (text) => text.replaceAll("ocplatform", "elizaos"),
      (text) => emitted.push(text),
      () => {
        finished = true;
      },
    );

    stream.write(Buffer.from("x".repeat(70) + "ocp", "utf8"));
    stream.write(Buffer.from("latform", "utf8"));
    stream.end();

    expect(emitted.join("")).toContain("elizaos");
    expect(emitted.join("")).not.toContain("ocplatform");
    expect(finished).toBe(true);
  });

  it("preserves multi-byte characters split across Buffer boundaries", () => {
    const emitted: string[] = [];
    const stream = createSseStream(
      (text) => text,
      (text) => emitted.push(text),
      () => undefined,
    );
    const payload = Buffer.from(`data: ${"x".repeat(70)} 中文 🚀\n\n`, "utf8");
    const splitInsideRocket = payload.indexOf(Buffer.from("🚀")) + 2;

    stream.write(payload.subarray(0, splitInsideRocket));
    stream.write(payload.subarray(splitInsideRocket));
    stream.end();

    const joined = emitted.join("");
    expect(joined).toContain("中文 🚀");
    expect(joined).not.toContain("\uFFFD");
  });

  it("calls finish even for empty streams", () => {
    const emitted: string[] = [];
    let finished = false;
    const stream = createSseStream(
      (text) => text,
      (text) => emitted.push(text),
      () => {
        finished = true;
      },
    );

    stream.end();

    expect(emitted).toEqual([]);
    expect(finished).toBe(true);
  });
});
