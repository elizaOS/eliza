import { type IAgentRuntime, type UUID } from '@elizaos/core';
import { TestSuite } from '../utils/test-suite';
import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * E2E Test for Message Service Integration
 *
 * This test validates that the message service correctly processes messages
 * through a live agent runtime.
 */
export default class CentralizedDataTestSuite extends TestSuite {
  public name = 'Message Service E2E Test';

  public tests = {
    'Should process message through messageService and generate response': async (
      runtime: IAgentRuntime
    ) => {
      // Create a test room
      const roomId = '123e4567-e89b-12d3-a456-426614174999' as UUID;

      // Create test message
      const userMessage = {
        id: '123e4567-e89b-12d3-a456-426614174998' as UUID,
        roomId,
        content: { text: 'Hello, how are you?', source: 'test' },
        entityId: '123e4567-e89b-12d3-a456-426614174997' as UUID,
        agentId: runtime.agentId,
        createdAt: Date.now(),
      };

      // Process the message through the live runtime
      const startTime = Date.now();
      const result = await runtime.messageService!.handleMessage(runtime, userMessage);
      const endTime = Date.now();

      // Validate result structure
      this.expect(result).toBeDefined();
      this.expect(typeof result.didRespond).toBe('boolean');
      this.expect(result.state).toBeDefined();

      // Validate execution time is reasonable
      const executionTime = endTime - startTime;
      this.expect(executionTime).toBeGreaterThan(0);
      this.expect(executionTime).toBeLessThan(60000); // Should complete within 60 seconds

      // Get the agent's response from memory
      const memories = await runtime.getMemories({
        tableName: 'messages',
        roomId,
        count: 10,
        unique: false,
      });

      this.expect(memories).toBeDefined();
      this.expect(Array.isArray(memories)).toBe(true);
    },

    'Should handle message deletion through messageService': async (runtime: IAgentRuntime) => {
      const roomId = '123e4567-e89b-12d3-a456-426614174996' as UUID;

      // Create and process a message
      const testMessage = {
        id: '123e4567-e89b-12d3-a456-426614174995' as UUID,
        roomId,
        content: { text: 'Message to delete', source: 'test' },
        entityId: '123e4567-e89b-12d3-a456-426614174994' as UUID,
        agentId: runtime.agentId,
        createdAt: Date.now(),
      };

      // Create the message in memory
      await runtime.createMemory(testMessage, 'messages');

      // Verify it exists
      const beforeDelete = await runtime.getMemoryById(testMessage.id);
      this.expect(beforeDelete).toBeDefined();

      // Delete using message service
      await runtime.messageService!.deleteMessage(runtime, testMessage);

      // Verify it's deleted
      const afterDelete = await runtime.getMemoryById(testMessage.id);
      this.expect(afterDelete).toBeNull();
    },

    'Should serialize test results to JSON file': async (runtime: IAgentRuntime) => {
      // Simple test data structure
      const testResult = {
        run_id: 'e2e-message-service-001',
        test_name: 'Message Service Integration',
        timestamp: new Date().toISOString(),
        success: true,
        agent_id: runtime.agentId,
        character_name: runtime.character.name,
      };

      // Act: Serialize to file
      const outputDir = '/tmp/e2e-test-output';
      await fs.mkdir(outputDir, { recursive: true });

      const filename = `test-${testResult.run_id}.json`;
      const filepath = path.join(outputDir, filename);

      await fs.writeFile(filepath, JSON.stringify(testResult, null, 2));

      // Assert: Verify file was created with correct content
      const fileExists = await fs
        .access(filepath)
        .then(() => true)
        .catch(() => false);
      this.expect(fileExists).toBe(true);

      const fileContent = await fs.readFile(filepath, 'utf-8');
      const parsedContent = JSON.parse(fileContent);

      this.expect(parsedContent.run_id).toBe(testResult.run_id);
      this.expect(parsedContent.success).toBe(true);

      // Verify pretty-printing (should have indentation)
      this.expect(fileContent).toContain('  "run_id":');

      // Cleanup
      await fs.unlink(filepath).catch(() => {}); // Ignore cleanup errors
    },
  };
}
