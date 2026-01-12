import { describe, expect, it } from "vitest";

describe("Planning Plugin Integration Tests", () => {
  describe("Plugin Structure", () => {
    it("should export planningPlugin", async () => {
      const { planningPlugin } = await import("../index");
      expect(planningPlugin).toBeDefined();
      expect(planningPlugin.name).toBe("@elizaos/plugin-planning");
    });

    it("should have correct description", async () => {
      const { planningPlugin } = await import("../index");
      expect(planningPlugin.description?.toLowerCase()).toContain("planning");
    });

    it("should have providers defined", async () => {
      const { planningPlugin } = await import("../index");
      expect(planningPlugin.providers).toBeDefined();
      expect(Array.isArray(planningPlugin.providers)).toBe(true);
    });

    it("should have actions defined", async () => {
      const { planningPlugin } = await import("../index");
      expect(planningPlugin.actions).toBeDefined();
      expect(Array.isArray(planningPlugin.actions)).toBe(true);
      expect(planningPlugin.actions?.length).toBeGreaterThan(0);
    });

    it("should have services defined", async () => {
      const { planningPlugin } = await import("../index");
      expect(planningPlugin.services).toBeDefined();
      expect(Array.isArray(planningPlugin.services)).toBe(true);
    });
  });

  describe("Actions", () => {
    it("should have analyzeInputAction", async () => {
      const { analyzeInputAction } = await import("../actions/chain-example");
      expect(analyzeInputAction).toBeDefined();
      expect(analyzeInputAction.name).toBe("ANALYZE_INPUT");
    });

    it("should have processAnalysisAction", async () => {
      const { processAnalysisAction } = await import("../actions/chain-example");
      expect(processAnalysisAction).toBeDefined();
      expect(processAnalysisAction.name).toBe("PROCESS_ANALYSIS");
    });

    it("should have executeFinalAction", async () => {
      const { executeFinalAction } = await import("../actions/chain-example");
      expect(executeFinalAction).toBeDefined();
      expect(executeFinalAction.name).toBe("EXECUTE_FINAL");
    });

    it("should have createPlanAction", async () => {
      const { createPlanAction } = await import("../actions/chain-example");
      expect(createPlanAction).toBeDefined();
      expect(createPlanAction.name).toBe("CREATE_PLAN");
    });
  });

  describe("Action Validation", () => {
    it("analyzeInputAction should validate any message", async () => {
      const { analyzeInputAction } = await import("../actions/chain-example");
      const message = { content: { text: "test message" } };
      const result = await analyzeInputAction.validate({} as never, message as never);
      expect(result).toBe(true);
    });

    it("createPlanAction should validate plan-related messages", async () => {
      const { createPlanAction } = await import("../actions/chain-example");
      const message = { content: { text: "create a plan for this project" } };
      const result = await createPlanAction.validate({} as never, message as never);
      expect(result).toBe(true);
    });

    it("createPlanAction should reject non-plan messages", async () => {
      const { createPlanAction } = await import("../actions/chain-example");
      const message = { content: { text: "hello world" } };
      const result = await createPlanAction.validate({} as never, message as never);
      expect(result).toBe(false);
    });
  });

  describe("Action Handlers", () => {
    it("analyzeInputAction should analyze text", async () => {
      const { analyzeInputAction } = await import("../actions/chain-example");
      const message = { content: { text: "This is an urgent test message with numbers 123" } };
      const result = await analyzeInputAction.handler({} as never, message as never, undefined, {});

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect((result.data as Record<string, number>).wordCount).toBeGreaterThan(0);
    });
  });

  describe("Providers", () => {
    it("should have messageClassifierProvider", async () => {
      const { messageClassifierProvider } = await import("../providers/message-classifier");
      expect(messageClassifierProvider).toBeDefined();
      expect(messageClassifierProvider.name).toBe("messageClassifier");
    });
  });

  describe("Service", () => {
    it("should export PlanningService", async () => {
      const { PlanningService } = await import("../services/planning-service");
      expect(PlanningService).toBeDefined();
    });
  });
});
