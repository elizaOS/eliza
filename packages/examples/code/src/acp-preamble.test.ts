/** Verifies ACP first-turn instructions name only tools available through the Pi profile. */

import { expect, it } from "bun:test";
import { buildAcpCodingPreamble } from "./acp-preamble.js";

it("instructs the ACP agent to use the exact Pi-shaped coding surface", () => {
  const text = buildAcpCodingPreamble("/workspace/project").join("\n");

  for (const tool of ["READ", "WRITE", "EDIT", "SHELL"]) {
    expect(text).toContain(tool);
  }
  expect(text).not.toMatch(/\bFILE\b/);
  expect(text).toContain("/workspace/project/<filename>");
});
