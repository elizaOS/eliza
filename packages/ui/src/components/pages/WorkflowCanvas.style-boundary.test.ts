/**
 * Guards the Workflow canvas renderer-style boundary. Node hosts may import
 * the UI component barrel while registering app routes, so component modules
 * cannot execute CSS imports; the renderer-owned styles entry supplies the
 * same React Flow stylesheet.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const UI_SOURCE_ROOT = path.resolve(import.meta.dirname, "..", "..");

describe("Workflow canvas style boundary", () => {
  it("keeps React Flow CSS in the renderer stylesheet only", async () => {
    const [componentSource, rendererStyles] = await Promise.all([
      readFile(
        path.join(UI_SOURCE_ROOT, "components/pages/WorkflowCanvas.tsx"),
        "utf8",
      ),
      readFile(path.join(UI_SOURCE_ROOT, "styles/styles.css"), "utf8"),
    ]);
    expect(componentSource).not.toContain("@xyflow/react/dist/style.css");
    expect(rendererStyles).toContain('@import "@xyflow/react/dist/style.css"');
  });
});
