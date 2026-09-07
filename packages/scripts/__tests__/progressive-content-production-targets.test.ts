/** Verifies the production soak pins every family to the readable medium-corpus coordinate. */

import { describe, expect, it } from "vitest";
import {
  PROGRESSIVE_CONTENT_SOAK_OBJECT_BYTES,
  selectProgressiveContentSoakObject,
} from "../lib/progressive-content-production-targets.mjs";

function object(id: string, byteLength: number, format = "lf-lines") {
  return { id, family: "document", byteLength, format };
}

describe("progressive-content production soak selection", () => {
  it("selects exactly 10 MiB instead of the largest available object", () => {
    const selected = selectProgressiveContentSoakObject(
      {
        objects: [
          object("document-100m", 100 * 1024 * 1024),
          object("document-10m", PROGRESSIVE_CONTENT_SOAK_OBJECT_BYTES),
          object("document-1m", 1024 * 1024),
        ],
      },
      { family: "document", binaryPolicy: "typed-rejection" },
    );
    expect(selected.id).toBe("document-10m");
  });

  it("rejects a family without the fixed readable coordinate", () => {
    expect(() =>
      selectProgressiveContentSoakObject(
        {
          objects: [
            object(
              "document-binary",
              PROGRESSIVE_CONTENT_SOAK_OBJECT_BYTES,
              "binary",
            ),
            object("document-100m", 100 * 1024 * 1024),
          ],
        },
        { family: "document", binaryPolicy: "typed-rejection" },
      ),
    ).toThrow(/no readable 10485760-byte soak object/u);
  });
});
