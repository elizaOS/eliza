import { describe, it, expect } from 'bun:test';
import formsPlugin from '../index';
import { createFormAction } from '../actions/create-form';
import { updateFormAction } from '../actions/update-form';
import { cancelFormAction } from '../actions/cancel-form';
import { formsProvider } from '../providers/forms-provider';
import { FormsService } from '../services/forms-service';

describe('Forms Plugin Configuration', () => {
  it('should have correct plugin metadata', () => {
    expect(formsPlugin.name).toBe('@elizaos/plugin-forms');
    expect(formsPlugin.description).toBe(
      'Structured form collection capabilities for conversational data gathering'
    );
  });

  it('should include all required components', () => {
    // Check services
    expect(formsPlugin.services).toContain(FormsService);
    expect(formsPlugin.services).toHaveLength(1);

    // Check actions
    expect(formsPlugin.actions).toContain(createFormAction);
    expect(formsPlugin.actions).toContain(updateFormAction);
    expect(formsPlugin.actions).toContain(cancelFormAction);
    expect(formsPlugin.actions).toHaveLength(3);

    // Check providers
    expect(formsPlugin.providers).toContain(formsProvider);
    expect(formsPlugin.providers).toHaveLength(1);

    // Check evaluators (should be empty)
    expect(formsPlugin.evaluators).toEqual([]);
  });

  it('should have sql plugin as dependency', () => {
    expect(formsPlugin.dependencies).toEqual(['@elizaos/plugin-sql']);
    expect(formsPlugin.testDependencies).toEqual(['@elizaos/plugin-sql']);
  });

  it('should have a test suite', () => {
    expect(formsPlugin.tests).toBeDefined();
    expect(formsPlugin.tests).toHaveLength(1);
  });
});

describe('Forms Actions', () => {
  describe('CREATE_FORM action', () => {
    it('should have correct metadata', () => {
      expect(createFormAction.name).toBe('CREATE_FORM');
      expect(createFormAction.similes).toContain('START_FORM');
      expect(createFormAction.similes).toContain('NEW_FORM');
      expect(createFormAction.similes).toContain('INIT_FORM');
      expect(createFormAction.similes).toContain('BEGIN_FORM');
      expect(createFormAction.description).toContain('Creates a new form');
    });

    it('should have examples', () => {
      expect(createFormAction.examples).toBeDefined();
      expect(createFormAction.examples).toBeTruthy();
      if (createFormAction.examples) {
        expect(createFormAction.examples.length).toBeGreaterThan(0);
      }
    });

    it('should have validate and handler functions', () => {
      expect(createFormAction.validate).toBeInstanceOf(Function);
      expect(createFormAction.handler).toBeInstanceOf(Function);
    });
  });

  describe('UPDATE_FORM action', () => {
    it('should have correct metadata', () => {
      expect(updateFormAction.name).toBe('UPDATE_FORM');
      expect(updateFormAction.similes).toContain('FILL_FORM');
      expect(updateFormAction.similes).toContain('COMPLETE_FORM');
      expect(updateFormAction.similes).toContain('SUBMIT_FORM');
      expect(updateFormAction.description).toContain('Updates an active form');
    });

    it('should have examples', () => {
      expect(updateFormAction.examples).toBeDefined();
      expect(updateFormAction.examples).toBeTruthy();
      if (updateFormAction.examples) {
        expect(updateFormAction.examples.length).toBeGreaterThan(0);
      }
    });

    it('should have validate and handler functions', () => {
      expect(updateFormAction.validate).toBeInstanceOf(Function);
      expect(updateFormAction.handler).toBeInstanceOf(Function);
    });
  });

  describe('CANCEL_FORM action', () => {
    it('should have correct metadata', () => {
      expect(cancelFormAction.name).toBe('CANCEL_FORM');
      expect(cancelFormAction.similes).toContain('ABORT_FORM');
      expect(cancelFormAction.similes).toContain('STOP_FORM');
      expect(cancelFormAction.similes).toContain('QUIT_FORM');
      expect(cancelFormAction.similes).toContain('EXIT_FORM');
      expect(cancelFormAction.description).toContain('Cancels an active form');
    });

    it('should have examples', () => {
      expect(cancelFormAction.examples).toBeDefined();
      expect(cancelFormAction.examples).toBeTruthy();
      if (cancelFormAction.examples) {
        expect(cancelFormAction.examples.length).toBeGreaterThan(0);
      }
    });

    it('should have validate and handler functions', () => {
      expect(cancelFormAction.validate).toBeInstanceOf(Function);
      expect(cancelFormAction.handler).toBeInstanceOf(Function);
    });
  });
});

describe('Forms Provider', () => {
  it('should have correct metadata', () => {
    expect(formsProvider.name).toBe('FORMS_CONTEXT');
    expect(formsProvider.description).toBe(
      'Provides context about active forms and their current state'
    );
  });

  it('should have a get function', () => {
    expect(formsProvider.get).toBeInstanceOf(Function);
  });
});

describe('FormsService', () => {
  it('should have correct service type', () => {
    expect(FormsService.serviceType).toBeDefined();
    expect(typeof FormsService.serviceType).toBe('string');
  });

  it('should have required static methods', () => {
    expect(FormsService.start).toBeInstanceOf(Function);
  });
});
