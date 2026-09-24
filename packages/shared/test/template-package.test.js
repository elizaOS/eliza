/** Exercises the built rendering, model-output and keyword leaves under native Node export conditions. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

it("runs published browser contracts without Node globals or runtime shims", async () => {
  const result = await build({
    stdin: {
      contents: `import { replaceNameTokens, resolveEnvAlias, ElizaError } from '@elizaos/shared/browser-contracts';
        globalThis.result = {
          text: replaceNameTokens('{{name}} and {{ agentName }}', 'M$&M'),
          alias: resolveEnvAlias('ELIZA_KEY', [['ELIZA_KEY', 'HOST_KEY']], {HOST_KEY: 'configured'}),
          code: new ElizaError('invalid input', {code: 'INPUT_INVALID'}).code
        };`,
      resolveDir: fileURLToPath(new URL("..", import.meta.url)),
    },
    bundle: true,
    // Exercise published export conditions rather than repository source aliases.
    tsconfigRaw: { compilerOptions: {} },
    platform: "browser",
    format: "iife",
    write: false,
  });
  const sandbox = {};
  runInNewContext(result.outputFiles[0].text, sandbox);
  assert.equal(sandbox.result.text, "M$&M and M$&M");
  assert.equal(sandbox.result.alias, "configured");
  assert.equal(sandbox.result.code, "INPUT_INVALID");
});

it("preserves runtime error classification through shared contracts in Node", () => {
  const probe = `
    import assert from 'node:assert/strict';
    import { ElizaError, isElizaError } from '@elizaos/core';
    import { ElizaError as SharedError } from '@elizaos/shared/browser-contracts';
    const cause = new Error('host failed');
    const error = new SharedError('configuration unavailable', {code: 'CONFIG_UNAVAILABLE', cause});
    assert.ok(error instanceof ElizaError);
    assert.ok(isElizaError(error));
    assert.equal(error.cause, cause);
    assert.equal(error.code, 'CONFIG_UNAVAILABLE');
    process.stdout.write('ok');
  `;
  assert.equal(
    execFileSync("node", ["--input-type=module", "--eval", probe], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      encoding: "utf8",
    }),
    "ok",
  );
});

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

for (const mode of ["source", "published"]) {
  it(`renders complete authored templates in the ${mode} browser graph`, async () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const result = await build({
      stdin: {
        contents: `import { composePrompt } from '@elizaos/shared/text/template-rendering';
          import { assertMcpJsonSchemaBudget } from './${mode === "source" ? "src/mcp/schema-budget.ts" : "dist/mcp/schema-budget.js"}';
          const cyclic = {}; cyclic.self = cyclic;
          let schemaError;
          try { assertMcpJsonSchemaBudget(cyclic); } catch (error) { schemaError = error.code; }
          const value = '<&> {{opaque}}' + 'long content '.repeat(12000);
          const state = { value, roomId: 'browser-room' };
          const template = '{{value}}|{{#if value}}complete{{/if}}|{{{slot}}}';
          state.slot = '{{name1}} and {{user1}}';
          globalThis.result = {
            value,
            schemaError,
            first: composePrompt({state, template}),
            again: composePrompt({state, template})
          };`,
        resolveDir: root,
      },
      bundle: true,
      tsconfigRaw: { compilerOptions: {} },
      platform: "browser",
      format: "iife",
      write: false,
      plugins: [
        {
          name: "renderer-runtime-boundary",
          setup(builder) {
            builder.onResolve({ filter: /^@elizaos\/core(?:\/|$)/ }, () => {
              throw new Error(
                "Node runtime barrel reached the browser template graph",
              );
            });
            if (mode === "source") {
              builder.onResolve(
                { filter: /^@elizaos\/shared\/text\/template-rendering$/ },
                () => ({
                  path: `${root}/src/text/template-rendering.ts`,
                }),
              );
              builder.onResolve(
                { filter: /^@elizaos\/shared\/browser-contracts$/ },
                () => ({
                  path: `${root}/scripts/browser-contracts-entry.ts`,
                }),
              );
            }
          },
        },
      ],
    });
    const sandbox = { TextEncoder };
    runInNewContext(result.outputFiles[0].text, sandbox, {
      contextCodeGeneration: { strings: false, wasm: false },
    });
    assert.equal(sandbox.result.schemaError, "MCP_TOOL_SCHEMA_UNBOUNDED");
    assert.equal(sandbox.result.first, sandbox.result.again);
    assert.ok(
      sandbox.result.first.startsWith(`${sandbox.result.value}|complete|`),
    );
    const names = sandbox.result.first.slice(
      sandbox.result.value.length + "|complete|".length,
    );
    const [first, second] = names.split(" and ");
    assert.ok(first.length > 0);
    assert.equal(first, second);
    assert.ok(!names.includes("{{"));
  });
}
