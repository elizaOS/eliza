import assert from "node:assert/strict";
import test from "node:test";
import { parseDescriptorJson } from "../strict-json.mjs";

test("bounded JSON refuses duplicate keys, parser ambiguities and resource exhaustion", () => {
  for (const bad of [
    '{"channel":"stable","channel":"beta"}',
    '{"a":{"x":1,"\\u0078":2}}',
    '{"a":01}',
    '{"a":1e2}',
    '{"a":-0}',
    '{"a":9007199254740993}',
    '{"a":true,}',
    "[1,]",
    '{"a":NaN}',
    "{} trailing",
    "/*comment*/{}",
    '["unterminated]',
    "[".repeat(34) + "0" + "]".repeat(34),
    JSON.stringify("x".repeat(4097)),
    JSON.stringify("\ud800"),
  ])
    assert.throws(() => parseDescriptorJson(Buffer.from(bad)));
  assert.throws(() => parseDescriptorJson(Buffer.from([0xc3, 0x28])));
  assert.throws(() => parseDescriptorJson(Buffer.alloc(1024 * 1024 + 1)));
  assert.throws(() =>
    parseDescriptorJson(Buffer.from(JSON.stringify(Array(4097).fill(1)))),
  );
  assert.equal(
    Object.getPrototypeOf(
      parseDescriptorJson(Buffer.from('{"__proto__":{"polluted":true}}')),
    ),
    null,
  );
  assert.equal({}.polluted, undefined);
});
