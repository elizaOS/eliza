import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { load } from 'js-yaml';
import { validateMatrixConfig } from '../matrix-schema';
import { join } from 'path';

describe('Example Matrix Configuration Validation', () => {
  it('should validate the github-issue-analysis.matrix.yaml example', () => {
    const examplePath = join(__dirname, '../../examples/github-issue-analysis.matrix.yaml');
    const fileContents = readFileSync(examplePath, 'utf8');
    const yamlData = load(fileContents);

    const result = validateMatrixConfig(yamlData);
    expect(result.success).toBe(true);

    if (result.success) {
      expect(result.data.name).toBe('GitHub Issue Action Chaining Analysis');
      expect(result.data.base_scenario).toBe(
        'src/commands/scenario/examples/test-github-issues.scenario.yaml'
      );
      expect(result.data.runs_per_combination).toBe(3);
      expect(result.data.matrix).toHaveLength(2);

      // Verify first matrix axis
      expect(result.data.matrix[0].parameter).toBe('run[0].input');
      expect(result.data.matrix[0].values).toHaveLength(3);

      // Verify second matrix axis
      expect(result.data.matrix[1].parameter).toBe('run[0].evaluations[0].value');
      expect(result.data.matrix[1].values).toEqual(['issues', 'GitHub']);
    }
  });
});
