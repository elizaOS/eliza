import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { IAgentRuntime, TestSuite } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { describe, expect, it } from "vitest";

export const ScratchpadServiceTestSuite: TestSuite = {
  name: "Scratchpad Service Unit Tests",
  tests: [
    {
      name: "should create a new scratchpad entry",
      fn: async (runtime: IAgentRuntime) => {
        logger.info("Testing scratchpad entry creation...");

        const { createScratchpadService } = await import("../services/scratchpadService");

        // Use a unique test directory
        const testDir = path.join(os.tmpdir(), `scratchpad-test-${Date.now()}`);
        const service = createScratchpadService(runtime, { basePath: testDir });

        try {
          const entry = await service.write("Test Note", "This is test content.", {
            tags: ["test", "unit"],
          });

          if (!entry.id) {
            throw new Error("Entry should have an ID");
          }
          if (entry.title !== "Test Note") {
            throw new Error(`Expected title 'Test Note', got '${entry.title}'`);
          }
          if (!entry.content.includes("This is test content.")) {
            throw new Error("Content should contain the written text");
          }
          if (!entry.tags?.includes("test")) {
            throw new Error("Entry should have the 'test' tag");
          }

          logger.info("✓ Scratchpad entry created successfully");

          // Verify file exists on disk
          const filePath = path.join(testDir, `${entry.id}.md`);
          await fs.access(filePath);
          logger.info("✓ Entry file exists on disk");

          logger.info("✅ Scratchpad entry creation test passed");
        } finally {
          // Cleanup
          await fs.rm(testDir, { recursive: true, force: true });
        }
      },
    },

    {
      name: "should read an existing scratchpad entry",
      fn: async (runtime: IAgentRuntime) => {
        logger.info("Testing scratchpad entry reading...");

        const { createScratchpadService } = await import("../services/scratchpadService");
        const testDir = path.join(os.tmpdir(), `scratchpad-test-${Date.now()}`);
        const service = createScratchpadService(runtime, { basePath: testDir });

        try {
          // Create an entry first
          const created = await service.write("Read Test", "Content to read back.");

          // Read it back
          const entry = await service.read(created.id);

          if (entry.id !== created.id) {
            throw new Error("Entry ID mismatch");
          }
          if (!entry.content.includes("Content to read back.")) {
            throw new Error("Content mismatch");
          }

          logger.info("✓ Scratchpad entry read successfully");
          logger.info("✅ Scratchpad entry reading test passed");
        } finally {
          await fs.rm(testDir, { recursive: true, force: true });
        }
      },
    },

    {
      name: "should read specific lines from an entry",
      fn: async (runtime: IAgentRuntime) => {
        logger.info("Testing partial line reading...");

        const { createScratchpadService } = await import("../services/scratchpadService");
        const testDir = path.join(os.tmpdir(), `scratchpad-test-${Date.now()}`);
        const service = createScratchpadService(runtime, { basePath: testDir });

        try {
          // Create an entry with multiple lines
          const multilineContent = "Line 1\nLine 2\nLine 3\nLine 4\nLine 5";
          await service.write("Multiline Test", multilineContent);

          // Read specific lines (accounting for frontmatter)
          const entry = await service.read("multiline-test", { from: 8, lines: 3 });
          const lines = entry.content.split("\n");

          if (lines.length !== 3) {
            throw new Error(`Expected 3 lines, got ${lines.length}`);
          }

          logger.info("✓ Partial line reading works");
          logger.info("✅ Partial line reading test passed");
        } finally {
          await fs.rm(testDir, { recursive: true, force: true });
        }
      },
    },

    {
      name: "should list all scratchpad entries",
      fn: async (runtime: IAgentRuntime) => {
        logger.info("Testing scratchpad listing...");

        const { createScratchpadService } = await import("../services/scratchpadService");
        const testDir = path.join(os.tmpdir(), `scratchpad-test-${Date.now()}`);
        const service = createScratchpadService(runtime, { basePath: testDir });

        try {
          // Create multiple entries
          await service.write("Note One", "Content one");
          await service.write("Note Two", "Content two");
          await service.write("Note Three", "Content three");

          const entries = await service.list();

          if (entries.length !== 3) {
            throw new Error(`Expected 3 entries, got ${entries.length}`);
          }

          const titles = entries.map((e: { title: string }) => e.title);
          if (!titles.includes("Note One") || !titles.includes("Note Two")) {
            throw new Error("Missing expected entries in list");
          }

          logger.info("✓ All entries listed correctly");
          logger.info("✅ Scratchpad listing test passed");
        } finally {
          await fs.rm(testDir, { recursive: true, force: true });
        }
      },
    },

    {
      name: "should search scratchpad entries",
      fn: async (runtime: IAgentRuntime) => {
        logger.info("Testing scratchpad search...");

        const { createScratchpadService } = await import("../services/scratchpadService");
        const testDir = path.join(os.tmpdir(), `scratchpad-test-${Date.now()}`);
        const service = createScratchpadService(runtime, { basePath: testDir });

        try {
          // Create entries with distinct content
          await service.write("Meeting Notes", "Discussion about project timeline and budget");
          await service.write("Shopping List", "Milk, eggs, bread, and cheese");
          await service.write("Project Ideas", "New feature ideas for the budget tracker app");

          // Search for "budget"
          const results = await service.search("budget");

          if (results.length < 2) {
            throw new Error(`Expected at least 2 results for 'budget', got ${results.length}`);
          }

          // Results should be sorted by score
          if (results.length > 1 && results[0].score < results[1].score) {
            throw new Error("Results should be sorted by score descending");
          }

          logger.info("✓ Search returns relevant results");

          // Search for something that doesn't exist
          const noResults = await service.search("xyznonexistent");
          if (noResults.length > 0) {
            throw new Error("Search should return empty for non-matching query");
          }

          logger.info("✓ Search returns empty for non-matching queries");
          logger.info("✅ Scratchpad search test passed");
        } finally {
          await fs.rm(testDir, { recursive: true, force: true });
        }
      },
    },

    {
      name: "should append content to existing entry",
      fn: async (runtime: IAgentRuntime) => {
        logger.info("Testing scratchpad append...");

        const { createScratchpadService } = await import("../services/scratchpadService");
        const testDir = path.join(os.tmpdir(), `scratchpad-test-${Date.now()}`);
        const service = createScratchpadService(runtime, { basePath: testDir });

        try {
          // Create initial entry
          const _original = await service.write("Append Test", "Original content.");

          // Append more content
          const appended = await service.write("Append Test", "Additional content.", {
            append: true,
          });

          if (!appended.content.includes("Original content.")) {
            throw new Error("Appended entry should contain original content");
          }
          if (!appended.content.includes("Additional content.")) {
            throw new Error("Appended entry should contain new content");
          }
          if (!appended.content.includes("---")) {
            throw new Error("Appended content should have separator");
          }

          logger.info("✓ Content appended successfully");
          logger.info("✅ Scratchpad append test passed");
        } finally {
          await fs.rm(testDir, { recursive: true, force: true });
        }
      },
    },

    {
      name: "should delete a scratchpad entry",
      fn: async (runtime: IAgentRuntime) => {
        logger.info("Testing scratchpad deletion...");

        const { createScratchpadService } = await import("../services/scratchpadService");
        const testDir = path.join(os.tmpdir(), `scratchpad-test-${Date.now()}`);
        const service = createScratchpadService(runtime, { basePath: testDir });

        try {
          // Create an entry
          const entry = await service.write("Delete Test", "Content to delete.");

          // Verify it exists
          const exists = await service.exists(entry.id);
          if (!exists) {
            throw new Error("Entry should exist before deletion");
          }

          // Delete it
          const deleted = await service.delete(entry.id);
          if (!deleted) {
            throw new Error("Delete should return true for existing entry");
          }

          // Verify it's gone
          const stillExists = await service.exists(entry.id);
          if (stillExists) {
            throw new Error("Entry should not exist after deletion");
          }

          logger.info("✓ Entry deleted successfully");

          // Deleting again should return false
          const deletedAgain = await service.delete(entry.id);
          if (deletedAgain) {
            throw new Error("Deleting non-existent entry should return false");
          }

          logger.info("✓ Deleting non-existent entry handled correctly");
          logger.info("✅ Scratchpad deletion test passed");
        } finally {
          await fs.rm(testDir, { recursive: true, force: true });
        }
      },
    },

    {
      name: "should handle entry not found gracefully",
      fn: async (runtime: IAgentRuntime) => {
        logger.info("Testing not found handling...");

        const { createScratchpadService } = await import("../services/scratchpadService");
        const testDir = path.join(os.tmpdir(), `scratchpad-test-${Date.now()}`);
        const service = createScratchpadService(runtime, { basePath: testDir });

        try {
          let errorThrown = false;
          try {
            await service.read("nonexistent-entry");
          } catch (error) {
            if (error instanceof Error && error.message.includes("not found")) {
              errorThrown = true;
            }
          }

          if (!errorThrown) {
            throw new Error("Should throw error for non-existent entry");
          }

          logger.info("✓ Not found handled gracefully");
          logger.info("✅ Not found handling test passed");
        } finally {
          await fs.rm(testDir, { recursive: true, force: true });
        }
      },
    },

    {
      name: "should generate correct summary",
      fn: async (runtime: IAgentRuntime) => {
        logger.info("Testing summary generation...");

        const { createScratchpadService } = await import("../services/scratchpadService");
        const testDir = path.join(os.tmpdir(), `scratchpad-test-${Date.now()}`);
        const service = createScratchpadService(runtime, { basePath: testDir });

        try {
          // Create a few entries
          await service.write("Summary Test One", "First entry content");
          await service.write("Summary Test Two", "Second entry content");

          const summary = await service.getSummary();

          if (!summary.includes("2 entries")) {
            throw new Error("Summary should mention entry count");
          }
          if (!summary.includes("Summary Test One")) {
            throw new Error("Summary should include entry titles");
          }

          logger.info("✓ Summary generated correctly");
          logger.info("✅ Summary generation test passed");
        } finally {
          await fs.rm(testDir, { recursive: true, force: true });
        }
      },
    },

    {
      name: "should sanitize filenames correctly",
      fn: async (runtime: IAgentRuntime) => {
        logger.info("Testing filename sanitization...");

        const { createScratchpadService } = await import("../services/scratchpadService");
        const testDir = path.join(os.tmpdir(), `scratchpad-test-${Date.now()}`);
        const service = createScratchpadService(runtime, { basePath: testDir });

        try {
          // Create entry with special characters in title
          const entry = await service.write(
            "Test!@#$%^&*() Special Characters!!!",
            "Content with special title"
          );

          // ID should be sanitized
          if (entry.id.includes("!") || entry.id.includes("@") || entry.id.includes("#")) {
            throw new Error("Entry ID should not contain special characters");
          }
          if (!entry.id.match(/^[a-z0-9-]+$/)) {
            throw new Error("Entry ID should only contain lowercase alphanumeric and hyphens");
          }

          // Should still be readable
          const readBack = await service.read(entry.id);
          if (readBack.title !== "Test!@#$%^&*() Special Characters!!!") {
            throw new Error("Original title should be preserved in content");
          }

          logger.info("✓ Filename sanitization works correctly");
          logger.info("✅ Filename sanitization test passed");
        } finally {
          await fs.rm(testDir, { recursive: true, force: true });
        }
      },
    },
  ],
};

describe(ScratchpadServiceTestSuite.name, () => {
  it("exports a non-empty test suite for service unit runner", () => {
    expect(ScratchpadServiceTestSuite.tests.length).toBeGreaterThan(0);
  });
});
