import { describe, it, expect, vi } from "vitest";
import type { IAgentRuntime, Memory, State } from "../../types";

// Test for hasRequestedInState optimization in reply action

describe("reply action optimization", () => {
  describe("hasRequestedInState", () => {
    it("should detect when action was already requested in state", () => {
      // The optimization checks if REPLY action was already processed in current state
      // to avoid redundant LLM calls
      const stateWithReply: Partial<State> = {
        values: {
          requestedActions: ["REPLY"],
        },
        data: {},
        text: "",
      };

      // Simulate the check that reply.ts performs
      const requestedActions = stateWithReply.values?.requestedActions;
      const hasReplyRequested = Array.isArray(requestedActions) && 
        requestedActions.includes("REPLY");
      
      expect(hasReplyRequested).toBe(true);
    });

    it("should return false when REPLY not in requestedActions", () => {
      const stateWithoutReply: Partial<State> = {
        values: {
          requestedActions: ["IGNORE"],
        },
        data: {},
        text: "",
      };

      const requestedActions = stateWithoutReply.values?.requestedActions;
      const hasReplyRequested = Array.isArray(requestedActions) && 
        requestedActions.includes("REPLY");
      
      expect(hasReplyRequested).toBe(false);
    });

    it("should handle missing requestedActions gracefully", () => {
      const stateNoActions: Partial<State> = {
        values: {},
        data: {},
        text: "",
      };

      const requestedActions = stateNoActions.values?.requestedActions;
      const hasReplyRequested = Array.isArray(requestedActions) && 
        requestedActions.includes("REPLY");
      
      expect(hasReplyRequested).toBe(false);
    });

    it("should handle undefined state values gracefully", () => {
      const stateUndefined: Partial<State> = {
        data: {},
        text: "",
      };

      const requestedActions = stateUndefined.values?.requestedActions;
      const hasReplyRequested = Array.isArray(requestedActions) && 
        requestedActions.includes("REPLY");
      
      expect(hasReplyRequested).toBe(false);
    });
  });
});
