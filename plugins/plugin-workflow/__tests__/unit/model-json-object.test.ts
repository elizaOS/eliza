/**
 * The workflow authoring path asks the model for JSON only, but a provider may
 * still wrap the draft in prose. The prose can carry braces: the generation
 * prompt itself spells fields as "{cron, timezone, enabled}". These cases pin
 * which reply the reader accepts and which it refuses.
 */
import { expect, test } from 'bun:test';
import { parseJsonObject } from '../../src/services/workflow-service';

const draft = {
  name: 'daily-digest',
  language: 'tsx',
  source:
    'export default smithers(() => <Workflow name="x"><Task id="t">{7 * 8}</Task></Workflow>);',
};
const body = JSON.stringify(draft);
const expected = draft as unknown as Record<string, unknown>;

test('reads a bare JSON object', () => {
  expect(parseJsonObject(body)).toEqual(expected);
});

test('reads an object inside a code fence', () => {
  expect(parseJsonObject(`\`\`\`json\n${body}\n\`\`\``)).toEqual(expected);
});

test('reads an object after prose that has no braces', () => {
  expect(parseJsonObject(`Here is the workflow.\n${body}`)).toEqual(expected);
});

test('reads the draft after prose that repeats the brace notation', () => {
  const reply = `I will add {cron, timezone, enabled} for the daily schedule.\n${body}`;
  expect(parseJsonObject(reply)).toEqual(expected);
});

test('reads the draft before prose that repeats the brace notation', () => {
  const reply = `${body}\n\nThe schedule field takes {cron, timezone, enabled}.`;
  expect(parseJsonObject(reply)).toEqual(expected);
});

test('reads the newest object when prose shows an example first', () => {
  const reply = `Example shape: {"name":"example"}\nHere is the workflow: ${body}`;
  expect(parseJsonObject(reply)).toEqual(expected);
});

test('refuses a reply that ends inside an unclosed object', () => {
  const reply = 'Example shape: {"name":"example"}\nHere is the workflow: {"name":"cut-off"';
  expect(() => parseJsonObject(reply)).toThrow();
});
