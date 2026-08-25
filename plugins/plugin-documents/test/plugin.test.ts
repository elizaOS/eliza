/** Manifest test for @elizaos/plugin-documents: asserts the index loads and the plugin registers its route surface, with the heavy UI renderer barrel mocked out for the node environment. */
import { describe, expect, it, vi } from "vitest";

// The plugin index re-exports the browser DocumentsView, which statically pulls
// the heavy `@elizaos/ui` renderer barrel (react-router et al.) — not resolvable
// under this node test environment and irrelevant to a manifest check. Mock it
// to the inert `client` surface the view touches (the same isolation every view
// test in this plugin uses) so the index loads here.
vi.mock("@elizaos/ui", () => ({
  client: { getBaseUrl: () => "http://test.local", sendChatMessage: () => {} },
}));

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
