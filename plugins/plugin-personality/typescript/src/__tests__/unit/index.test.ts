import { describe, it, expect } from 'bun:test';
import selfModificationPlugin from '../../index';
import { CharacterFileManager } from '../../services/character-file-manager';

describe('Self Modification Plugin', () => {
  it('should export a valid plugin object', () => {
    expect(selfModificationPlugin).toBeDefined();
    expect(selfModificationPlugin.name).toBe('@elizaos/plugin-personality');
    expect(selfModificationPlugin.description).toBeDefined();
  });

  it('should have actions array', () => {
    expect(selfModificationPlugin.actions).toBeDefined();
    expect(Array.isArray(selfModificationPlugin.actions)).toBe(true);
    expect(selfModificationPlugin.actions!.length).toBeGreaterThan(0);
  });

  it('should have evaluators array', () => {
    expect(selfModificationPlugin.evaluators).toBeDefined();
    expect(Array.isArray(selfModificationPlugin.evaluators)).toBe(true);
    expect(selfModificationPlugin.evaluators!.length).toBeGreaterThan(0);
  });

  it('should have services array', () => {
    expect(selfModificationPlugin.services).toBeDefined();
    expect(Array.isArray(selfModificationPlugin.services)).toBe(true);
    expect(selfModificationPlugin.services!.length).toBeGreaterThan(0);
  });

  it('should contain MODIFY_CHARACTER action', () => {
    const modifyAction = selfModificationPlugin.actions?.find(
      (action) => action.name === 'MODIFY_CHARACTER'
    );
    expect(modifyAction).toBeDefined();
    expect(modifyAction?.description).toBeDefined();
    expect(modifyAction?.validate).toBeDefined();
    expect(modifyAction?.handler).toBeDefined();
  });

  it('should contain CHARACTER_EVOLUTION evaluator', () => {
    const evaluator = selfModificationPlugin.evaluators?.find(
      (evaluatorItem) => evaluatorItem.name === 'CHARACTER_EVOLUTION'
    );
    expect(evaluator).toBeDefined();
    expect(evaluator?.description).toBeDefined();
    expect(evaluator?.validate).toBeDefined();
    expect(evaluator?.handler).toBeDefined();
  });

  it('should contain CharacterFileManager service', () => {
    const service = selfModificationPlugin.services?.find((svc) => svc === CharacterFileManager);
    expect(service).toBeDefined();
  });

  it('should have proper plugin metadata', () => {
    expect(selfModificationPlugin.name).toBe('@elizaos/plugin-personality');
    expect(selfModificationPlugin.description).toContain('self-modification');
  });
});
