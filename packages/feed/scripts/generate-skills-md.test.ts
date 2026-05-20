import { describe, expect, test } from 'bun:test';
import {
  generateSkillsMarkdown,
  parseAgentCardSkills,
  parseExecutorOperations,
  parseMCPTools,
} from './generate-skills-md';

describe('generate-skills-md', () => {
  test('parseAgentCardSkills', async () => {
    const mockContent = `
    skills: [
      {
        id: 'test-skill',
        name: 'Test Skill',
        description: 
        'This is a test skill description',
        tags: ['test', 'skill'],
        examples: [
          'Example 1',
          'Example 2'
        ],
        inputModes: [],
      }
    ],
    `;

    const result = parseAgentCardSkills(mockContent);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('test-skill');
    expect(result[0]?.name).toBe('Test Skill');
    expect(result[0]?.description).toBe('This is a test skill description');
    expect(result[0]?.tags).toEqual(['test', 'skill']);
    expect(result[0]?.examples).toEqual(['Example 1', 'Example 2']);
  });

  test('parseExecutorOperations', async () => {
    const mockContent = `
    switch (operation) {
      case 'test.operation1':
        return handleOp1();
      case 'test.operation2':
        return handleOp2();
      case 'default':
        return handleDefault();
    }
    `;

    const result = parseExecutorOperations(mockContent);
    expect(result).toHaveLength(2);
    expect(result).toContain('test.operation1');
    expect(result).toContain('test.operation2');
    expect(result).not.toContain('default');
  });

  test('parseMCPTools', async () => {
    const mockContent = `
    return [
      {
        name: 'tool1',
        description: 'Tool 1 description'
      },
      {
        name: 'tool2',
        description: 
        'Tool 2 multiline description'
      }
    ];
    `;

    const result = parseMCPTools(mockContent);
    expect(result).toHaveLength(2);
    expect(result[0]?.name).toBe('tool1');
    expect(result[0]?.description).toBe('Tool 1 description');
    expect(result[1]?.name).toBe('tool2');
    expect(result[1]?.description).toBe('Tool 2 multiline description');
  });

  test('generateSkillsMarkdown', async () => {
    const skills = [
      {
        id: 'test-skill',
        name: 'Test Skill',
        description: 'Skill description',
        tags: ['test'],
        examples: ['Example'],
      },
    ];
    const operations = ['test.operation1', 'test.operation2'];
    const byPrefix = new Map([
      ['test', ['test.operation1', 'test.operation2']],
    ]);
    const mcpTools = [{ name: 'tool1', description: 'Tool 1 description' }];

    const markdown = generateSkillsMarkdown(
      skills,
      operations,
      byPrefix,
      mcpTools
    );
    expect(markdown).toContain('# Babylon Agent Skills');
    expect(markdown).toContain('Test Skill');
    expect(markdown).toContain('test.operation1');
    expect(markdown).toContain('tool1');
  });
});
