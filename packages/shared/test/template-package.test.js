/** Exercises the built rendering, model-output and keyword leaves under native Node export conditions. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

it("loads complete template helpers from the shared distribution in native Node", {
  timeout: 60_000,
}, () => {
  const probe = `
    import assert from 'node:assert/strict';
    import { composePrompt } from '@elizaos/shared/text/template-rendering';
    import { parseJSONObjectFromText } from '@elizaos/shared/text/model-output';
    import { textIncludesKeywordTerm } from '@elizaos/shared/i18n/keyword-matching-core';
    const value = '<tag>\\n{{opaque}}'.repeat(16384) + 'END';
    assert.equal(composePrompt({state: {value}, template: '{{value}}'}), value);
    assert.deepEqual(parseJSONObjectFromText('{answer:42,}'), {answer:42});
    assert.equal(parseJSONObjectFromText('[1]'), null);
    assert.equal(textIncludesKeywordTerm('open calendar', 'calendar'), true);
    assert.equal(textIncludesKeywordTerm('category', 'cat'), false);
    assert.ok(import.meta.resolve('@elizaos/shared/text/template-rendering').endsWith('/dist/text/template-rendering.js'));
    process.stdout.write('ok');
  `;
  for (const conditions of [
    [],
    ["--conditions=module"],
    ["--conditions=development"],
    ["--conditions=production"],
  ]) {
    assert.equal(
      execFileSync(
        "node",
        [...conditions, "--input-type=module", "--eval", probe],
        {
          cwd: fileURLToPath(new URL("..", import.meta.url)),
          encoding: "utf8",
        },
      ),
      "ok",
    );
  }
});
