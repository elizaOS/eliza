/** Verifies real grammar registration and rendering through native Node ESM resolution. */
// @vitest-environment node

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("loads and highlights code without a bundler or DOM", () => {
  const output = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
        import { createElement } from 'react';
        import { renderToStaticMarkup } from 'react-dom/server';
        import { SyntaxHighlighter } from './prism-light.ts';
        const code = 'const answer = 42;';
        process.stdout.write(renderToStaticMarkup(
          createElement(SyntaxHighlighter, { language: 'typescript' }, code),
        ));
      `,
    ],
    { cwd: fileURLToPath(new URL(".", import.meta.url)), encoding: "utf8" },
  );

  expect(output).toContain("<pre");
  expect(output).toContain("<span");
  expect(output.replace(/<[^>]+>/g, "")).toBe("const answer = 42;");
});
