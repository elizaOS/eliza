/** Pins Steward stylesheet ownership to the renderer CSS entry. */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const stewardStylesImport = 'import "@stwd/react/styles.css";';

describe("Steward renderer stylesheet ownership", () => {
  it("keeps the runtime graph JavaScript-only and loads Steward CSS from @elizaos/ui/styles", () => {
    const runtimeSource = readFileSync(
      resolve(here, "StewardProviderRuntime.tsx"),
      "utf8",
    );
    const rendererStylesSource = readFileSync(
      resolve(here, "../../styles.ts"),
      "utf8",
    );

    expect(runtimeSource).not.toContain(stewardStylesImport);
    expect(rendererStylesSource).toContain(stewardStylesImport);
  });
});
