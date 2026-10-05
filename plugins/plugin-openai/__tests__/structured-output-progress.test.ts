/** JSON lexical state survives chunk boundaries without changing content. */
import { expect, it } from "vitest";
import { StructuredOutputProgressGuard } from "../models/structured-output-progress";

it("counts only outside-string JSON whitespace and resets on progress", () => {
  const controller = new AbortController();
  const guard = new StructuredOutputProgressGuard(controller);
  guard.observe('{"text":"escaped \\');
  guard.observe('"');
  guard.observe(" ".repeat(10000));
  guard.observe('"');
  guard.observe(" ".repeat(4096));
  guard.observe(",");
  guard.observe("\n".repeat(4096));
  expect(controller.signal.aborted).toBe(false);
  expect(() => guard.observe("\t")).toThrow(
    expect.objectContaining({ code: "STRUCTURED_OUTPUT_STALLED" })
  );
  expect(controller.signal.reason).toMatchObject({ code: "STRUCTURED_OUTPUT_STALLED" });
});
