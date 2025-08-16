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
            expect(result.data.name).toBe("GitHub Issue Action Chaining Analysis");
            expect(result.data.base_scenario).toBe("packages/cli/src/commands/scenario/examples/test-github-issues.scenario.yaml");
            expect(result.data.runs_per_combination).toBe(3);
            expect(result.data.matrix).toHaveLength(2);

            // Verify first matrix axis
            expect(result.data.matrix[0].parameter).toBe("character.llm.model");
            expect(result.data.matrix[0].values).toEqual(["gpt-4-turbo", "gpt-3.5-turbo"]);

            // Verify second matrix axis
            expect(result.data.matrix[1].parameter).toBe("run[0].input");
            expect(result.data.matrix[1].values).toHaveLength(3);
        }
    });
});
