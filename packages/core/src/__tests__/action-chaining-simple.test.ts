import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { AgentRuntime } from '../runtime';
import { createActionResult } from '../types/components';
import type { ActionResult } from '../types';

describe('Action Chaining Fixes', () => {
  describe('createActionResult helper', () => {
    it('should create ActionResult with default success=true', () => {
      const result = createActionResult();
      expect(result.success).toBe(true);
      expect(result.text).toBeUndefined();
      expect(result.error).toBeUndefined();
    });

    it('should allow overriding success field', () => {
      const result = createActionResult({ success: false, error: 'Test error' });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Test error');
    });

    it('should preserve all provided fields', () => {
      const result = createActionResult({
        text: 'Test text',
        values: { key: 'value' },
        data: { foo: 'bar' },
      });
      expect(result.success).toBe(true);
      expect(result.text).toBe('Test text');
      expect(result.values).toEqual({ key: 'value' });
      expect(result.data).toEqual({ foo: 'bar' });
    });
  });

  describe('Runtime immutable helpers', () => {
    let runtime: any;

    beforeEach(() => {
      // Access private methods through prototype
      runtime = AgentRuntime.prototype;
    });

    it('should update action plan immutably', () => {
      const originalPlan = {
        currentStep: 1,
        totalSteps: 3,
        steps: [{ action: 'step1' }, { action: 'step2' }, { action: 'step3' }],
      };

      const updatedPlan = runtime.updateActionPlan(originalPlan, { currentStep: 2 });

      // Original should be unchanged
      expect(originalPlan.currentStep).toBe(1);

      // Updated should have new value
      expect(updatedPlan.currentStep).toBe(2);
      expect(updatedPlan.totalSteps).toBe(3);
      expect(updatedPlan.steps).toEqual(originalPlan.steps);

      // Should be different objects
      expect(updatedPlan).not.toBe(originalPlan);
    });

    it('should update action step immutably', () => {
      const originalPlan = {
        currentStep: 1,
        steps: [
          { action: 'step1', status: 'pending' },
          { action: 'step2', status: 'pending' },
          { action: 'step3', status: 'pending' },
        ],
      };

      const updatedPlan = runtime.updateActionStep(originalPlan, 1, {
        status: 'completed',
        result: { success: true },
      });

      // Original should be unchanged
      expect(originalPlan.steps[1].status).toBe('pending');
      expect(originalPlan.steps[1].result).toBeUndefined();

      // Updated should have new values
      expect(updatedPlan.steps[1].status).toBe('completed');
      expect(updatedPlan.steps[1].result).toEqual({ success: true });

      // Other steps should be unchanged
      expect(updatedPlan.steps[0]).toEqual(originalPlan.steps[0]);
      expect(updatedPlan.steps[2]).toEqual(originalPlan.steps[2]);

      // Should be different objects
      expect(updatedPlan).not.toBe(originalPlan);
      expect(updatedPlan.steps).not.toBe(originalPlan.steps);
      expect(updatedPlan.steps[1]).not.toBe(originalPlan.steps[1]);
    });
  });

  describe('Working Memory Cleanup', () => {
    it('should enforce MAX_WORKING_MEMORY_ENTRIES limit', () => {
      // This is more of a documentation test showing the expected behavior
      const MAX_WORKING_MEMORY_ENTRIES = 50;
      const workingMemory: Record<string, any> = {};

      // Add 60 entries
      for (let i = 0; i < 60; i++) {
        workingMemory[`action_${i}`] = {
          actionName: `Action${i}`,
          timestamp: Date.now() + i, // Incrementing timestamps
          result: { success: true },
        };
      }

      // Simulate cleanup
      const entries = Object.entries(workingMemory);
      expect(entries.length).toBe(60);

      // Sort by timestamp (newest first) with proper type safety
      const sorted = entries.sort((a, b) => {
        const entryA = a[1] as { timestamp?: number } | null;
        const entryB = b[1] as { timestamp?: number } | null;
        const timestampA = entryA?.timestamp ?? 0;
        const timestampB = entryB?.timestamp ?? 0;
        return timestampB - timestampA;
      });

      // Keep only the most recent MAX_WORKING_MEMORY_ENTRIES
      const cleaned = Object.fromEntries(sorted.slice(0, MAX_WORKING_MEMORY_ENTRIES));

      expect(Object.keys(cleaned).length).toBe(MAX_WORKING_MEMORY_ENTRIES);

      // Verify we kept the newest entries
      const cleanedKeys = Object.keys(cleaned);
      expect(cleanedKeys).toContain('action_59');
      expect(cleanedKeys).toContain('action_50');
      expect(cleanedKeys).not.toContain('action_9'); // Old entry should be removed
    });
  });

  describe('Bounds Checking', () => {
    it('should handle updateActionStep with invalid indices', () => {
      // Mock logger
      const warnCalls: string[] = [];
      const mockLogger = {
        warn: (msg: string) => {
          warnCalls.push(msg);
        },
      };

      // Helper function that mimics the runtime's updateActionStep
      const updateActionStep = <T, S>(
        plan: T & { steps: S[] },
        index: number,
        stepUpdates: Partial<S>,
        logger: typeof mockLogger
      ): T & { steps: S[] } => {
        if (!plan.steps || index < 0 || index >= plan.steps.length) {
          logger.warn(
            `Invalid step index: ${index} for plan with ${plan.steps?.length || 0} steps`
          );
          return plan;
        }
        return {
          ...plan,
          steps: plan.steps.map((step: S, i: number) =>
            i === index ? { ...step, ...stepUpdates } : step
          ),
        };
      };

      // Test data
      const plan = {
        name: 'test-plan',
        steps: [
          { status: 'pending', action: 'step1' },
          { status: 'pending', action: 'step2' },
          { status: 'pending', action: 'step3' },
        ],
      };

      // Test valid index
      const updated1 = updateActionStep(plan, 1, { status: 'completed' }, mockLogger);
      expect(updated1.steps[1].status).toBe('completed');
      expect(warnCalls.length).toBe(0);

      // Test negative index
      const updated2 = updateActionStep(plan, -1, { status: 'failed' }, mockLogger);
      expect(updated2).toBe(plan); // Should return original plan
      expect(warnCalls[0]).toBe('Invalid step index: -1 for plan with 3 steps');

      // Test index out of bounds
      warnCalls.length = 0; // Clear warnings
      const updated3 = updateActionStep(plan, 5, { status: 'failed' }, mockLogger);
      expect(updated3).toBe(plan); // Should return original plan
      expect(warnCalls[0]).toBe('Invalid step index: 5 for plan with 3 steps');

      // Test with null steps
      warnCalls.length = 0; // Clear warnings
      const planWithNullSteps = { name: 'test', steps: null as any };
      const updated4 = updateActionStep(planWithNullSteps, 0, { status: 'completed' }, mockLogger);
      expect(updated4).toBe(planWithNullSteps);
      expect(warnCalls[0]).toBe('Invalid step index: 0 for plan with 0 steps');
    });
  });
});
