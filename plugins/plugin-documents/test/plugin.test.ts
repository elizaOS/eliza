import { describe, expect, it } from "vitest";

import * as documentExports from "../src/index.ts";
import { documentsPlugin } from "../src/plugin.ts";

describe("documentsPlugin manifest", () => {
  it("keeps OWNER_DOCUMENTS host-adapted by personal-assistant", () => {
    expect(documentsPlugin.actions ?? []).toEqual([]);
    expect("ownerDocumentsAction" in documentExports).toBe(false);
  });

  it("registers document routes and the documents view", () => {
    expect(documentsPlugin.routes?.length).toBeGreaterThan(0);
    expect(documentsPlugin.views?.map((view) => view.id)).toEqual([
      "documents",
    ]);
  });
});
