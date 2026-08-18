/**
 * Tests for `createSseStream`: reverse-map patterns and multi-byte UTF-8 /
 * surrogate-pair sequences split across chunk boundaries flush intact. Pure,
 * no network.
 */

import { describe, expect, it } from "vitest";
import { ELIZA_TOOL_RENAMES } from "../src/proxy/eliza-fingerprint.js";
import { reverseMap } from "../src/proxy/reverse-map.js";
import { applyReplacements } from "../src/proxy/sanitize.js";
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
      }
    );

    stream.write(Buffer.from(`${"x".repeat(70)}ocp`, "utf8"));
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
      () => undefined
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

  it("reverse-maps a token that straddles the internal 64-char tail cut", () => {
    // Single write: the pattern lands at offset 32 of a 100-char payload, so
    // the internal tail cut (mapped.length - 64) falls inside "ocplatform".
    // Transforming the flushable prefix in isolation left the head un-mapped
    // and leaked the pattern verbatim (issue #21257).
    const emitted: string[] = [];
    const stream = createSseStream(
      (text) => text.replaceAll("ocplatform", "elizaos"),
      (text) => emitted.push(text),
      () => undefined
    );

    stream.write(Buffer.from(`${"x".repeat(32)}ocplatform${"y".repeat(58)}`, "utf8"));
    stream.end();

    const joined = emitted.join("");
    expect(joined).not.toContain("ocplatform");
    expect(joined).toContain("elizaos");
    expect(joined).toBe(`${"x".repeat(32)}elizaos${"y".repeat(58)}`);
  });

  it("never leaks the pattern at any offset across a >128-char buffer", () => {
    // Sweep the pattern across every start offset so no boundary position
    // (relative to the internal cut) can leak. Adversarial coverage of the
    // position-dependent failure.
    const pattern = "ocplatform";
    const total = 160;
    for (let offset = 0; offset + pattern.length <= total; offset++) {
      const before = "x".repeat(offset);
      const after = "y".repeat(total - offset - pattern.length);
      const payload = before + pattern + after;
      const emitted: string[] = [];
      const stream = createSseStream(
        (text) => text.replaceAll(pattern, "elizaos"),
        (text) => emitted.push(text),
        () => undefined
      );
      stream.write(Buffer.from(payload, "utf8"));
      stream.end();
      const joined = emitted.join("");
      expect(joined, `offset ${offset}`).not.toContain(pattern);
      expect(joined, `offset ${offset}`).toBe(`${before}elizaos${after}`);
    }
  });

  it('reverse-maps a real "Write" tool name that straddles the cut in an input_json_delta', () => {
    // The analogous production leak: an SSE input_json_delta / content_block_start
    // whose CC tool name ("Write") lands on the internal cut must still reverse
    // to the eliza name ("write_file") so tool-call recognition works.
    const config = {
      toolRenames: ELIZA_TOOL_RENAMES,
      propRenames: [] as ReadonlyArray<readonly [string, string]>,
      reverseMap: [] as ReadonlyArray<readonly [string, string]>,
    };
    const reverse = (text: string) => reverseMap(text, config);
    const suffix = `"input":{}}${"z".repeat(60)}`;
    // Position "Write" so the 64-char tail cut splits the quoted token.
    const prefix = `event: content_block_start\ndata: {"type":"tool_use",${"a".repeat(10)}`;
    const payload = `${prefix}"name":"Write",${suffix}`;

    const emitted: string[] = [];
    const stream = createSseStream(
      reverse,
      (text) => emitted.push(text),
      () => undefined
    );
    stream.write(Buffer.from(payload, "utf8"));
    stream.end();

    const joined = emitted.join("");
    expect(joined).toContain('"name":"write_file"');
    expect(joined).not.toContain('"name":"Write"');
  });

  it('reverse-maps "Write" no matter where it lands relative to the cut', () => {
    const config = {
      toolRenames: ELIZA_TOOL_RENAMES,
      propRenames: [] as ReadonlyArray<readonly [string, string]>,
      reverseMap: [] as ReadonlyArray<readonly [string, string]>,
    };
    const reverse = (text: string) => reverseMap(text, config);
    const token = '"name":"Write"';
    for (let offset = 0; offset <= 140; offset += 1) {
      const payload = `${"a".repeat(offset)}${token}${"b".repeat(140 - offset)}`;
      const emitted: string[] = [];
      const stream = createSseStream(
        reverse,
        (text) => emitted.push(text),
        () => undefined
      );
      stream.write(Buffer.from(payload, "utf8"));
      stream.end();
      const joined = emitted.join("");
      expect(joined, `offset ${offset}`).toContain('"name":"write_file"');
      expect(joined, `offset ${offset}`).not.toContain('"name":"Write"');
    }
  });

  it("maps a default tool rename once when input arrives byte by byte", () => {
    const config = {
      toolRenames: ELIZA_TOOL_RENAMES,
      propRenames: [] as ReadonlyArray<readonly [string, string]>,
      reverseMap: [] as ReadonlyArray<readonly [string, string]>,
    };
    const reverse = (text: string) => reverseMap(text, config);
    // Drip the token in one-byte chunks to exercise decoder/event buffering.
    const payload = `${"c".repeat(80)}"name":"Write"${"d".repeat(80)}`;
    const emitted: string[] = [];
    const stream = createSseStream(
      reverse,
      (text) => emitted.push(text),
      () => undefined
    );
    for (const byte of Buffer.from(payload, "utf8")) {
      stream.write(Buffer.from([byte]));
    }
    stream.end();
    const joined = emitted.join("");
    expect(joined).toBe(`${"c".repeat(80)}"name":"write_file"${"d".repeat(80)}`);
  });

  it("applies a non-idempotent custom reverse map exactly once", () => {
    const pairs = [
      ["B", "C"],
      ["A", "B"],
    ] as const;
    const emitted: string[] = [];
    const stream = createSseStream(
      (text) => applyReplacements(text, pairs),
      (text) => emitted.push(text),
      () => undefined
    );
    const firstEvent = `data: ${"x".repeat(70)}A\n\n`;
    const secondEvent = "data: done\n\n";

    stream.write(Buffer.from(firstEvent));
    stream.write(Buffer.from(secondEvent));
    stream.end();

    expect(emitted.join("")).toBe(applyReplacements(firstEvent + secondEvent, pairs));
    expect(emitted.join("")).toContain("B\n\n");
    expect(emitted.join("")).not.toContain("C\n\n");
  });

  it("buffers custom reverse-map keys longer than 64 characters", () => {
    const pattern = "K".repeat(80);
    const emitted: string[] = [];
    const stream = createSseStream(
      (text) => text.replaceAll(pattern, "mapped"),
      (text) => emitted.push(text),
      () => undefined
    );

    stream.write(Buffer.from(`data: ${"x".repeat(70)}${pattern.slice(0, 70)}`));
    stream.write(Buffer.from(`${pattern.slice(70)}\n\n`));
    stream.end();

    expect(emitted.join("")).toBe(`data: ${"x".repeat(70)}mapped\n\n`);
  });

  it.each(["\n", "\r", "\r\n"])(
    "emits an event with %j line endings before the upstream stream ends",
    (lineEnd) => {
      const emitted: string[] = [];
      const stream = createSseStream(
        (text) => text.replaceAll("Write", "write_file"),
        (text) => emitted.push(text),
        () => undefined
      );
      const event = `event: content_block_start${lineEnd}data: {"name":"Write"}${lineEnd}${lineEnd}`;

      stream.write(Buffer.from(`${event}partial`));

      expect(emitted).toEqual([event.replace("Write", "write_file")]);
      stream.end();
      expect(emitted.join("")).toContain("partial");
    }
  );

  it("calls finish even for empty streams", () => {
    const emitted: string[] = [];
    let finished = false;
    const stream = createSseStream(
      (text) => text,
      (text) => emitted.push(text),
      () => {
        finished = true;
      }
    );

    stream.end();

    expect(emitted).toEqual([]);
    expect(finished).toBe(true);
  });
});
