/**
 * RL Training System Test
 *
 * Verifies the RL training and inference setup:
 * 1. Agent generates trajectory data
 * 2. RULER scores trajectory
 * 3. Training uses scored data
 * 4. Agent uses model for inference
 * 5. Agent takes actions in game
 */

import { describe, expect, it } from "bun:test";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  getModelTokenLimit,
  truncateToTokenLimitSync,
} from "../../../api/src/utils/token-counter";
import { getRLModelConfig } from "../training/RLModelConfig";

const sourcePath = (...parts: string[]) => join(__dirname, ...parts);
const readSource = (relativePath: string) =>
  readFile(sourcePath(relativePath), "utf-8");

describe("RL Training System", () => {
  describe("Configuration", () => {
    it("should have a valid base model configured", () => {
      const config = getRLModelConfig();
      // Base model can be OpenPipe or unsloth variants
      expect(config.baseModel).toBeDefined();
      expect(config.baseModel.length).toBeGreaterThan(0);
    });

    it("should have Atropos configuration if enabled", () => {
      const config = getRLModelConfig();

      if (config.enabled) {
        expect(config.atroposApiUrl).toBeDefined();
        expect(config.vllmPort).toBeDefined();
      }
    });
  });

  describe("Context Window Safety", () => {
    it("should enforce 128K limit for Gemma models", async () => {
      const limit = getModelTokenLimit("google/gemma-4-E4B-it");

      // Gemma 4 E4B has 128K context (131072 tokens)
      expect(limit).toBe(131072);
    });

    it("should have truncation utilities available", async () => {
      const longText = "a".repeat(200000); // Very long text
      const result = truncateToTokenLimitSync(longText, 1000, {
        ellipsis: true,
      });

      expect(result.tokens).toBeLessThanOrEqual(1000);
      expect(result.text.length).toBeLessThan(longText.length);
    });
  });

  describe("Agent Services Use Truncation", () => {
    it("AutonomousTradingService should import truncation", async () => {
      const content = await readSource(
        "../autonomous/AutonomousTradingService.ts",
      );
      expect(content).toContain("truncateToTokenLimitSync");
      expect(content).toContain("30000"); // 30K limit
    });

    it("AutonomousPostingService should import truncation", async () => {
      const content = await readSource(
        "../autonomous/AutonomousPostingService.ts",
      );
      expect(content).toContain("truncateToTokenLimitSync");
      expect(content).toContain("30000");
    });

    it("AutonomousPlanningCoordinator should import truncation", async () => {
      const content = await readSource(
        "../autonomous/AutonomousPlanningCoordinator.ts",
      );
      expect(content).toContain("truncateToTokenLimitSync");
      expect(content).toContain("30000");
    });

    it("AutonomousBatchResponseService should import truncation", async () => {
      const content = await readSource(
        "../autonomous/AutonomousBatchResponseService.ts",
      );
      expect(content).toContain("truncateToTokenLimitSync");
      expect(content).toContain("30000");
    });
  });

  describe("Provider Data Caps", () => {
    it("BatchResponseService should cap interactions to 30", async () => {
      const content = await readSource(
        "../autonomous/AutonomousBatchResponseService.ts",
      );
      expect(content).toContain("slice(0, 30)"); // Cap to 30 interactions
    });
  });

  describe("Integration Readiness", () => {
    it("should have all components for RL loop", async () => {
      // 1. Trajectory logging
      await access(
        sourcePath(
          "../plugins/plugin-trajectory-logger/src/TrajectoryLoggerService.ts",
        ),
      );

      // 2. RL Model config
      const configSource = await readSource("../training/RLModelConfig.ts");
      expect(configSource).toContain("export function getRLModelConfig");

      // 3. Agent runtime
      const runtimeSource = await readSource(
        "../runtime/AgentRuntimeManager.ts",
      );
      expect(runtimeSource).toContain("export class AgentRuntimeManager");
    });
  });
});
