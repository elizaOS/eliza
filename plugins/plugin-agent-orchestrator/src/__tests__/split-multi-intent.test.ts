import { describe, expect, it } from "vitest";
import { splitMultiIntentTask } from "../actions/start-coding-task.js";

describe("splitMultiIntentTask", () => {
  it("returns single-element array for empty or undefined input", () => {
    expect(splitMultiIntentTask("")).toEqual([""]);
  });

  it("returns single-element array for plain prose", () => {
    const input = "build me a tip calculator with a slider for people count";
    expect(splitMultiIntentTask(input)).toEqual([input]);
  });

  it("does NOT split inline numbered sequential steps on one line", () => {
    const input =
      "1. cd eliza 2. run `bun test` 3. save output to a file. in order.";
    const out = splitMultiIntentTask(input);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(input);
  });

  it("splits newline-separated numbered distinct asks", () => {
    const input = [
      "1. research X framework",
      "2. research Y framework",
      "3. write a comparison doc",
    ].join("\n");
    const out = splitMultiIntentTask(input);
    expect(out).toHaveLength(3);
    expect(out[0]).toBe("research X framework");
    expect(out[2]).toBe("write a comparison doc");
  });

  it("splits bulleted list with >=2 items", () => {
    const input = [
      "please handle these:",
      "- build a landing page",
      "- deploy it to the server",
      "- wire up analytics",
    ].join("\n");
    const out = splitMultiIntentTask(input);
    expect(out).toHaveLength(3);
    expect(out[0]).toBe("build a landing page");
  });

  it("absorbs a continuation line into the previous numbered item", () => {
    const input = [
      "1. research polymarket",
      "   include volume stats",
      "2. compare to kalshi",
    ].join("\n");
    const out = splitMultiIntentTask(input);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe("research polymarket include volume stats");
    expect(out[1]).toBe("compare to kalshi");
  });

  it("does not split on a single numbered item", () => {
    const input = "1. just do this one thing";
    expect(splitMultiIntentTask(input)).toHaveLength(1);
  });
});
