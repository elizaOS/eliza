/**
 * Draft generation reads one JSON object out of the model reply. Prose that
 * describes the object can contain braces of its own ("uses {name} and
 * {source}"), so a span from the first `{` to the last `}` is not the draft.
 * These cases drive the parser the generation path uses and assert that the
 * object the model returned is the one that is read, and that a cut-off reply
 * is rejected instead of being read as the example in the prose.
 */
import { describe, expect, test } from 'bun:test';
import { parseJsonObject } from '../src/services/workflow-service';

const DRAFT = {
  name: 'prose-brace',
  language: 'tsx',
  source: 'export default smithers(() => null);',
};

describe('workflow draft JSON is read from the reply, not from prose braces', () => {
  test('prose with braces before the object does not hide the draft', () => {
    const reply = `The workflow object uses {name} and {source} fields:\n${JSON.stringify(DRAFT)}`;

    expect(parseJsonObject(reply)).toEqual(DRAFT);
  });

  test('trailing prose after the object does not change the draft', () => {
    const reply = `${JSON.stringify(DRAFT)}\n\nThis draft runs after approval.`;

    expect(parseJsonObject(reply)).toEqual(DRAFT);
  });

  test('a fenced reply is read with its braces inside the source string', () => {
    const reply = ['```json', JSON.stringify(DRAFT), '```'].join('\n');

    expect(parseJsonObject(reply)).toEqual(DRAFT);
  });

  test('a cut-off reply rejects without reading the example object', () => {
    const example = JSON.stringify({ name: 'example', language: 'tsx', source: 'export {};' });
    const cutOff = `${example}\nNow the real draft:\n${JSON.stringify(DRAFT).slice(0, -40)}`;

    expect(() => parseJsonObject(cutOff)).toThrow('ends before it closes');
  });

  test('a reply with no object still reports the generation error', () => {
    expect(() => parseJsonObject('I cannot create that workflow.')).toThrow(
      'did not return a valid Smithers workflow object'
    );
  });
});
