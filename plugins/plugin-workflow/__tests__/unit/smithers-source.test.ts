/** Validates the native Smithers source boundary and its legacy-schema rejection contract. */
import { describe, expect, test } from 'bun:test';
import { validateSmithersSource } from '../../src/services/smithers-runtime';

const validSource = `/** @jsxImportSource smthrs */
import { createSmithers } from 'smthrs/create';
const { Workflow, smithers } = createSmithers({}, { dbPath: process.env.ELIZA_SMTHRS_DB_PATH });
export default smithers(() => <Workflow name="test" />);`;

describe('native Smithers workflow source', () => {
  test('accepts a default-exported smthrs module', () => {
    expect(() => validateSmithersSource(validSource)).not.toThrow();
  });

  test('rejects missing source, missing default exports, and legacy packages', () => {
    expect(() => validateSmithersSource('')).toThrow('source is required');
    expect(() => validateSmithersSource("import { Smithers } from 'smthrs';")).toThrow(
      'default-export'
    );
    expect(() =>
      validateSmithersSource(
        "import { Smithers } from '@smithers-orchestrator/engine'; export default Smithers;"
      )
    ).toThrow('import its runtime from smthrs');
  });
});
