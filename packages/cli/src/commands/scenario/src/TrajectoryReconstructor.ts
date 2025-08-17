/**
 * Non-Invasive Trajectory Reconstruction (Ticket #5785)
 * 
 * This service reconstructs agent trajectory from existing database logs
 * and memories WITHOUT modifying the core runtime.
 */

import { AgentRuntime, UUID } from '@elizaos/core';

/**
 * Agent trajectory step (matching expected format from test data)
 */
export interface TrajectoryStep {
    /** Unix timestamp (seconds) */
    timestamp: number;

    /** The agent's thought/reasoning process */
    thought: string;

    /** The name of the action being executed */
    action: string;

    /** The parameters passed to the action */
    action_input: Record<string, any>;

    /** The result/observation from the action */
    observation: string;
}

export interface ReconstructedTrajectory {
    steps: TrajectoryStep[];
    runId?: UUID;
    startTime: number;
    endTime: number;
    totalSteps: number;
}

export class TrajectoryReconstructor {
    private runtime: AgentRuntime;

    constructor(runtime: AgentRuntime) {
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
            unique: false
        });

        console.log(`\n🔍 [TrajectoryReconstructor] ===== MEMORY ANALYSIS START =====`);
        console.log(`🔍 [TrajectoryReconstructor] Found ${allMemories.length} total memories for agent`);

        // DEBUG: Show all roomIds from memories to identify mismatch
        console.log(`🔍 [TrajectoryReconstructor] All roomIds found in memories:`);
        const uniqueRoomIds = [...new Set(allMemories.map(m => m.roomId).filter(Boolean))];
        uniqueRoomIds.forEach((rId, i) => {
            const count = allMemories.filter(m => m.roomId === rId).length;
            console.log(`   ${i + 1}. ${rId} (${count} memories)`);
        });
        console.log(`🔍 [TrajectoryReconstructor] Original roomId: ${roomId}`);

        // FIX: Use the roomId that actually has memories, not the one passed in
        // This fixes the fundamental mismatch between API roomId and stored memory roomId
        const actualRoomId = uniqueRoomIds.length > 0 ? uniqueRoomIds[0] : roomId;
        if (actualRoomId !== roomId) {
            console.log(`🔧 [TrajectoryReconstructor] ROOMID MISMATCH DETECTED - Using actual roomId: ${actualRoomId}`);
        }

        // Filter by ACTUAL roomId where memories are stored
        const memories = allMemories.filter(mem => mem && mem.roomId === actualRoomId);
        console.log(`🔍 [TrajectoryReconstructor] Found ${memories.length} memories using actual roomId`);

        // Log ALL memories to understand what we have available
        memories.forEach((mem, index) => {
            console.log(`\n--- Memory ${index + 1}/${memories.length} ---`);
            console.log(`ID: ${mem.id}`);
            console.log(`CreatedAt: ${mem.createdAt} (${new Date(mem.createdAt || 0).toISOString()})`);
            console.log(`Type: ${(mem as any).type || 'undefined'}`);
            console.log(`Content Type: ${typeof mem.content}`);

            if (mem.content && typeof mem.content === 'object') {
                console.log(`Content.type: ${(mem.content as any)?.type}`);
                console.log(`Content keys:`, Object.keys(mem.content));

                // Log full content for action results (this is what works in evaluator)
                if ((mem.content as any)?.type === 'action_result') {
                    console.log(`🎯 FOUND ACTION_RESULT - FULL CONTENT:`, JSON.stringify(mem.content, null, 2));
                } else if ((mem.content as any)?.type === 'user' || (mem.content as any)?.type === 'agent') {
                    console.log(`💬 MESSAGE CONTENT:`, JSON.stringify({
                        type: (mem.content as any).type,
                        text: (mem.content as any).text,
                        content: (mem.content as any).content
                    }, null, 2));
                } else {
                    console.log(`📋 OTHER CONTENT:`, JSON.stringify(mem.content, null, 2));
                }
            } else {
                console.log(`Raw Content:`, mem.content);
            }
        });

        console.log(`🔍 [TrajectoryReconstructor] ===== MEMORY ANALYSIS END =====\n`);

        // Use same filtering as the working evaluator
        const actionMemories = memories.filter(
            (mem) => mem && typeof mem.content === 'object' && (mem.content as any)?.type === 'action_result'
        );

        // Reconstruct trajectory steps from action memories
        const steps: TrajectoryStep[] = [];
        const runIds = new Set<UUID>();

        console.log(`🎯 [TrajectoryReconstructor] Processing ${actionMemories.length} action memories...`);

        // Process action memories to build trajectory (using EXACT same approach as working evaluator)
        for (const memory of actionMemories) {
            const content = memory.content as any;

            console.log(`\n🔄 Processing action memory ${memory.id}...`);
            console.log(`   actionName: ${content?.actionName}`);
            console.log(`   actionParams:`, content?.actionParams);
            console.log(`   actionResult:`, content?.actionResult);
            console.log(`   thought:`, content?.thought);
            console.log(`   actionStatus:`, content?.actionStatus);

            // Extract action information (same structure as TrajectoryContainsActionEvaluator)
            const actionName = content?.actionName || 'unknown';
            const actionParams = content?.actionParams || {};
            const actionResult = content?.actionResult || {};
            const thought = content?.thought || '';

            // Get observation content from various possible locations
            let observationContent = '';
            if (actionResult?.text) {
                observationContent = actionResult.text;
            } else if (actionResult?.stdout) {
                observationContent = actionResult.stdout;
            } else if (actionResult?.output) {
                observationContent = actionResult.output;
            } else if (typeof actionResult === 'string') {
                observationContent = actionResult;
            } else if (actionResult && typeof actionResult === 'object') {
                observationContent = JSON.stringify(actionResult);
            }

            console.log(`   📋 Extracted observation (${observationContent.length} chars):`, observationContent.substring(0, 200));

            // Create unified trajectory step (matching expected format from test data)
            const step: TrajectoryStep = {
                timestamp: Math.floor((memory.createdAt || Date.now()) / 1000), // Convert to seconds
                thought,
                action: actionName,
                action_input: actionParams,
                observation: observationContent
            };

            console.log(`   ✅ Created trajectory step:`, JSON.stringify(step, null, 2));
            steps.push(step);
        }

        // Sort all steps by timestamp
        steps.sort((a, b) => a.timestamp - b.timestamp);

        return {
            steps,
            runId: runIds.size === 1 ? Array.from(runIds)[0] : undefined,
            startTime,
            endTime,
            totalSteps: steps.length
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

            console.log(`📊 [TrajectoryReconstructor] Found ${trajectory.steps.length} trajectory steps on attempt ${attempt}`);
            console.log(`📊 [TrajectoryReconstructor] Time window: ${trajectory.startTime} - ${trajectory.endTime}`);

            if (trajectory.steps.length > 0) {
                console.log(`✅ [TrajectoryReconstructor] SUCCESS on attempt ${attempt}: Found ${trajectory.steps.length} trajectory steps`);
                console.log(`📊 [TrajectoryReconstructor] Actions found:`, trajectory.steps.map(s => s.action));
                console.log(`📊 [TrajectoryReconstructor] First step sample:`, JSON.stringify(trajectory.steps[0], null, 2));
                console.log(`📊 [TrajectoryReconstructor] ===== SUCCESS END =====\n`);
                return trajectory.steps;
            }

            console.log(`⚠️ [TrajectoryReconstructor] Attempt ${attempt} found 0 steps. ${attempt < maxRetries ? 'Retrying...' : 'Final attempt failed.'}`);

            // Wait before next retry (except on final attempt)
            if (attempt < maxRetries) {
                console.log(`⏳ [TrajectoryReconstructor] Waiting ${retryDelayMs}ms before retry...`);
                await new Promise(resolve => setTimeout(resolve, retryDelayMs));
            }
        }

        console.log(`❌ [TrajectoryReconstructor] All ${maxRetries} attempts failed - returning empty trajectory`);
        console.log(`📊 [TrajectoryReconstructor] ===== FINAL FAILURE =====\n`);
        return [];
    }
}
