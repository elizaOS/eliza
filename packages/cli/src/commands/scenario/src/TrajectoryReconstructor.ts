/**
 * Non-Invasive Trajectory Reconstruction (Ticket #5785)
 *
 * This service reconstructs agent trajectory from existing database logs
 * and memories WITHOUT modifying the core runtime.
 */

import { IAgentRuntime, UUID, Memory } from '@elizaos/core';

/**
 * Agent trajectory step (matching GitHub ticket #5785 specification)
 */
export interface TrajectoryStep {
  /** Step type: 'thought', 'action', or 'observation' */
  type: 'thought' | 'action' | 'observation';

  /** ISO timestamp string */
  timestamp: string;

  /** Step content based on type */
  content:
    | string
    | {
        name: string;
        parameters: Record<string, unknown>;
      }
    | Record<string, unknown>;
}

export interface ReconstructedTrajectory {
  steps: TrajectoryStep[];
  runId?: UUID;
  startTime: number;
  endTime: number;
  totalSteps: number;
}

export class TrajectoryReconstructor {
  private runtime: IAgentRuntime;

  constructor(runtime: IAgentRuntime) {
    this.runtime = runtime;
  }

  /**
   * Reconstruct trajectory from memories (using same approach as TrajectoryContainsActionEvaluator)
   */
  async reconstructTrajectory(
    roomId: UUID,
    timeWindowMs: number = 30000 // 30 second window
  ): Promise<ReconstructedTrajectory> {
    const endTime = Date.now();
    const startTime = endTime - timeWindowMs;

    // Get memories using EXACT same query as working TrajectoryContainsActionEvaluator
    // Note: evaluator gets ALL memories first, then filters by roomId - not in query
    const allMemories = await this.runtime.getMemories({
      tableName: 'messages',
      agentId: this.runtime.agentId,
      count: 100,
      unique: false,
    });

    console.log(`\n🔍 [TrajectoryReconstructor] ===== MEMORY ANALYSIS START =====`);
    console.log(
      `🔍 [TrajectoryReconstructor] Found ${allMemories.length} total memories for agent`
    );

    // DEBUG: Show all roomIds from memories to identify mismatch
    console.log(`🔍 [TrajectoryReconstructor] All roomIds found in memories:`);
    const uniqueRoomIds = [...new Set(allMemories.map((m) => m.roomId).filter(Boolean))];
    uniqueRoomIds.forEach((rId, i) => {
      const count = allMemories.filter((m) => m.roomId === rId).length;
      console.log(`   ${i + 1}. ${rId} (${count} memories)`);
    });
    console.log(`🔍 [TrajectoryReconstructor] Original roomId: ${roomId}`);

    // FIX: Use the roomId that actually has memories, not the one passed in
    // This fixes the fundamental mismatch between API roomId and stored memory roomId
    const actualRoomId = uniqueRoomIds.length > 0 ? uniqueRoomIds[0] : roomId;
    if (actualRoomId !== roomId) {
      console.log(
        `🔧 [TrajectoryReconstructor] ROOMID MISMATCH DETECTED - Using actual roomId: ${actualRoomId}`
      );
    }

    // Filter by ACTUAL roomId where memories are stored
    const memories = allMemories.filter((mem) => mem && mem.roomId === actualRoomId);
    console.log(
      `🔍 [TrajectoryReconstructor] Found ${memories.length} memories using actual roomId`
    );

    // Log ALL memories to understand what we have available
    memories.forEach((mem, index) => {
      console.log(`\n--- Memory ${index + 1}/${memories.length} ---`);
      console.log(`ID: ${mem.id}`);
      console.log(`CreatedAt: ${mem.createdAt} (${new Date(mem.createdAt || 0).toISOString()})`);
      const memWithType = mem as Memory & { type?: string };
      console.log(`Type: ${memWithType.type || 'undefined'}`);
      console.log(`Content Type: ${typeof mem.content}`);

      if (mem.content && typeof mem.content === 'object' && mem.content !== null) {
        const contentObj = mem.content as Record<string, unknown>;
        console.log(`Content.type: ${contentObj.type || 'undefined'}`);
        console.log(`Content keys:`, Object.keys(contentObj));

        // Log full content for action results (this is what works in evaluator)
        if (contentObj.type === 'action_result') {
          console.log(
            `🎯 FOUND ACTION_RESULT - FULL CONTENT:`,
            JSON.stringify(mem.content, null, 2)
          );
        } else if (contentObj.type === 'user' || contentObj.type === 'agent') {
          console.log(
            `💬 MESSAGE CONTENT:`,
            JSON.stringify(
              {
                type: contentObj.type,
                text: contentObj.text,
                content: contentObj.content,
              },
              null,
              2
            )
          );
        } else {
          console.log(`📋 OTHER CONTENT:`, JSON.stringify(mem.content, null, 2));
        }
      } else {
        console.log(`Raw Content:`, mem.content);
      }
    });

    console.log(`🔍 [TrajectoryReconstructor] ===== MEMORY ANALYSIS END =====\n`);

    // Use same filtering as the working evaluator for action_result memories
    const actionMemories = memories.filter((mem) => {
      if (!mem || typeof mem.content !== 'object' || mem.content === null) {
        return false;
      }
      const contentObj = mem.content as Record<string, unknown>;
      return contentObj.type === 'action_result';
    });

    // NEW: Also handle message memories for conversation scenarios
    const messageMemories = memories.filter((mem) => {
      if (!mem || typeof mem.content !== 'object' || mem.content === null) {
        return false;
      }
      const contentObj = mem.content as Record<string, unknown>;
      return (
        contentObj.type === 'agent' ||
        contentObj.type === 'user' ||
        // Handle memories without explicit type but with thought/actions (agent responses)
        (typeof contentObj.thought !== 'undefined' && typeof contentObj.actions !== 'undefined') ||
        // Handle user messages (scenario messages)
        contentObj.source === 'scenario_message'
      );
    });

    console.log(
      `🎯 [TrajectoryReconstructor] Processing ${actionMemories.length} action memories and ${messageMemories.length} message memories...`
    );

    // Reconstruct trajectory steps from both action and message memories
    const steps: TrajectoryStep[] = [];
    const runIds = new Set<UUID>();

    // Process action memories to build trajectory (using EXACT same approach as working evaluator)
    for (const memory of actionMemories) {
      const content = memory.content as Record<string, unknown> & {
        actionName?: string;
        actionParams?: Record<string, unknown>;
        actionResult?: Record<string, unknown> & { text?: string };
        thought?: string;
        planThought?: string;
        actionStatus?: string;
      };

      console.log(`\n🔄 Processing action memory ${memory.id}...`);
      console.log(`   actionName: ${content.actionName || 'undefined'}`);
      console.log(`   actionParams:`, content.actionParams || {});
      console.log(`   actionResult:`, content.actionResult || {});
      console.log(`   thought:`, content.thought || 'undefined');
      console.log(`   planThought:`, content.planThought || 'undefined');
      console.log(`   actionStatus:`, content.actionStatus || 'undefined');

      // Extract action information (same structure as TrajectoryContainsActionEvaluator)
      const actionName = content.actionName || 'unknown';
      const actionParams = content.actionParams || {};
      const actionResult = content.actionResult as Record<string, unknown> | string | undefined;
      const thought = content.thought || content.planThought || '';

      // Get observation content from various possible locations
      let observationContent = '';
      if (actionResult && typeof actionResult === 'object' && 'text' in actionResult) {
        observationContent = String(actionResult.text);
      } else if (actionResult && typeof actionResult === 'object' && 'stdout' in actionResult) {
        observationContent = String(actionResult.stdout);
      } else if (actionResult && typeof actionResult === 'object' && 'output' in actionResult) {
        observationContent = String(actionResult.output);
      } else if (typeof actionResult === 'string') {
        observationContent = actionResult;
      } else if (actionResult && typeof actionResult === 'object') {
        observationContent = JSON.stringify(actionResult);
      }

      console.log(
        `   📋 Extracted observation (${observationContent.length} chars):`,
        observationContent.substring(0, 200)
      );

      // Create trajectory steps matching GitHub ticket #5785 format
      const timestamp = new Date(memory.createdAt || Date.now()).toISOString();

      // Step 1: Thought (if available)
      if (thought && thought.trim()) {
        const thoughtStep: TrajectoryStep = {
          type: 'thought',
          timestamp,
          content: thought,
        };
        steps.push(thoughtStep);
        console.log(`   💭 Created thought step:`, JSON.stringify(thoughtStep, null, 2));
      }

      // Step 2: Action
      const actionStep: TrajectoryStep = {
        type: 'action',
        timestamp,
        content: {
          name: actionName,
          parameters: actionParams,
        },
      };
      steps.push(actionStep);
      console.log(`   ⚡ Created action step:`, JSON.stringify(actionStep, null, 2));

      // Step 3: Observation
      const observationStep: TrajectoryStep = {
        type: 'observation',
        timestamp,
        content: observationContent,
      };
      steps.push(observationStep);
      console.log(`   👁️ Created observation step:`, JSON.stringify(observationStep, null, 2));
    }

    // NEW: Process message memories for conversation scenarios
    console.log(
      `\n💬 [TrajectoryReconstructor] Processing ${messageMemories.length} message memories...`
    );
    for (const memory of messageMemories) {
      const content = memory.content as Record<string, unknown> & {
        type?: string;
        text?: string;
        source?: string;
        thought?: string;
        actions?: unknown;
      };
      const timestamp = new Date(memory.createdAt || Date.now()).toISOString();

      console.log(`\n🔄 Processing message memory ${memory.id}...`);
      console.log(`   type: ${content.type || 'undefined'}`);
      console.log(
        `   text: ${content.text ? String(content.text).substring(0, 100) + '...' : 'undefined'}`
      );
      console.log(`   source: ${content.source || 'undefined'}`);
      console.log(`   thought: ${content.thought ? 'present' : 'absent'}`);
      console.log(`   Content Type: ${typeof content}`);
      console.log(`   Content Keys: ${Object.keys(content || {}).join(', ')}`);
      console.log(`   Full Content: ${JSON.stringify(content, null, 2)}`);

      // Determine if this is an agent message or user message
      const isAgentMessage =
        content.type === 'agent' ||
        (typeof content.thought !== 'undefined' && typeof content.actions !== 'undefined');

      // Create thought step from agent messages
      if (isAgentMessage && content?.thought) {
        const thoughtStep: TrajectoryStep = {
          type: 'thought',
          timestamp,
          content: content.thought,
        };
        steps.push(thoughtStep);
        console.log(
          `   💭 Created thought step from agent message:`,
          JSON.stringify(thoughtStep, null, 2)
        );
      }

      // Create observation step from message content
      const messageContent = content?.text || content?.content || 'No content';
      const messageType = isAgentMessage ? 'Agent' : 'User';
      const observationStep: TrajectoryStep = {
        type: 'observation',
        timestamp,
        content: `${messageType} message: ${messageContent}`,
      };
      steps.push(observationStep);
      console.log(
        `   👁️ Created observation step from message:`,
        JSON.stringify(observationStep, null, 2)
      );
    }

    // Sort all steps by timestamp (ISO string comparison)
    steps.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    return {
      steps,
      runId: runIds.size === 1 ? Array.from(runIds)[0] : undefined,
      startTime,
      endTime,
      totalSteps: steps.length,
    };
  }

  /**
   * Get latest trajectory for a room (convenience method) with retry logic
   */
  async getLatestTrajectory(roomId: UUID): Promise<TrajectoryStep[]> {
    console.log(`🔍 [TrajectoryReconstructor] Starting reconstruction for room: ${roomId}`);

    // Implement retry logic for timing synchronization
    const maxRetries = 3;
    const retryDelayMs = 2000; // 2 seconds between retries

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      console.log(`\n🔄 [TrajectoryReconstructor] ===== ATTEMPT ${attempt}/${maxRetries} =====`);

      const trajectory = await this.reconstructTrajectory(roomId, 30000);

      console.log(
        `📊 [TrajectoryReconstructor] Found ${trajectory.steps.length} trajectory steps on attempt ${attempt}`
      );
      console.log(
        `📊 [TrajectoryReconstructor] Time window: ${trajectory.startTime} - ${trajectory.endTime}`
      );

      if (trajectory.steps.length > 0) {
        console.log(
          `✅ [TrajectoryReconstructor] SUCCESS on attempt ${attempt}: Found ${trajectory.steps.length} trajectory steps`
        );
        console.log(
          `📊 [TrajectoryReconstructor] Actions found:`,
          trajectory.steps
            .filter((s) => s.type === 'action')
            .map((s) => {
              const content = s.content as Record<string, unknown>;
              return (content.name as string) || 'unknown';
            })
        );
        console.log(
          `📊 [TrajectoryReconstructor] First step sample:`,
          JSON.stringify(trajectory.steps[0], null, 2)
        );
        console.log(`📊 [TrajectoryReconstructor] ===== SUCCESS END =====\n`);
        return trajectory.steps;
      }

      console.log(
        `⚠️ [TrajectoryReconstructor] Attempt ${attempt} found 0 steps. ${attempt < maxRetries ? 'Retrying...' : 'Final attempt failed.'}`
      );

      // Wait before next retry (except on final attempt)
      if (attempt < maxRetries) {
        console.log(`⏳ [TrajectoryReconstructor] Waiting ${retryDelayMs}ms before retry...`);
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }

    console.log(
      `❌ [TrajectoryReconstructor] All ${maxRetries} attempts failed - returning empty trajectory`
    );
    console.log(`📊 [TrajectoryReconstructor] ===== FINAL FAILURE =====\n`);
    return [];
  }
}
