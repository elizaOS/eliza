import {
  IAgentRuntime,
  Route,
  UUID,
  ChannelType,
  SOCKET_MESSAGE_TYPE,
  createUniqueUuid,
} from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';
import { io } from 'socket.io-client';
import * as path from 'path';
import { ActionBenchEvaluator } from '../evaluators/action-bench-evaluator';
import { ActionBenchLoader } from '../utils/action-bench-loader';
import { TestResult, StepResult } from '../types/action-bench-types';

const DEFAULT_SERVER_ID = '00000000-0000-0000-0000-000000000000';

interface TestRequest {
  testType: string;
  clientId: string;
  channelId?: string; // Optional - if provided, use existing channel
  message?: string;
  baseUrl: string;
}

interface CreateChannelRequest {
  testType: string;
  clientId: string;
  channelId?: string; // Optional predetermined channel ID
  baseUrl: string;
}

// Route to create a test channel
export const createChannelRoute: Route = {
  type: 'POST',
  name: 'Create Test Channel',
  path: '/action-bench/create-channel',

  handler: async (req: any, res: any, runtime: IAgentRuntime) => {
    console.log('🔗 CREATE CHANNEL ROUTE CALLED');

    try {
      const {
        testType,
        clientId,
        channelId: predeterminedChannelId,
        baseUrl,
      }: CreateChannelRequest = req.body || {};

      console.log('📦 Create Channel Request:', {
        testType,
        clientId,
        predeterminedChannelId,
        baseUrl,
      });

      if (!testType || !clientId) {
        throw new Error('testType and clientId are required');
      }

      const userId = clientId as UUID;
      const agentId = runtime.agentId;

      console.log(
        '🔗 Creating DM channel for test:',
        testType,
        predeterminedChannelId
          ? `with predetermined ID: ${predeterminedChannelId}`
          : 'with auto-generated ID'
      );
      const channelId = await createTestChannel(
        userId,
        agentId,
        testType,
        baseUrl,
        predeterminedChannelId as UUID
      );

      console.log('✅ Test channel created successfully:', channelId);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          success: true,
          message: 'Test channel created successfully',
          data: {
            channelId,
            testType,
            timestamp: new Date().toISOString(),
          },
        })
      );
    } catch (error) {
      console.error('❌ Channel creation failed:', error);

      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          success: false,
          error: error instanceof Error ? error.message : String(error),
          timestamp: new Date().toISOString(),
        })
      );
    }
  },
};

// Route to run test with existing channel
export const testRoute: Route = {
  type: 'POST',
  name: 'Action Bench Test Runner',
  path: '/action-bench/test',

  handler: async (req: any, res: any, runtime: IAgentRuntime) => {
    console.log('='.repeat(50));
    console.log('🚀 ACTION BENCH TEST ROUTE CALLED');
    console.log('='.repeat(50));

    try {
      // Parse request body
      const { testType, clientId, channelId, baseUrl }: TestRequest = req.body || {};

      console.log('📦 Test Request:', { testType, clientId, channelId, baseUrl });

      if (!testType || !clientId) {
        throw new Error('testType and clientId are required');
      }

      const userId = clientId as UUID;
      let testChannelId = channelId;

      // If no channel provided, create one (fallback)
      if (!testChannelId) {
        console.log('⚠️ No channel provided, creating new one...');
        const agentId = runtime.agentId;
        testChannelId = await createTestChannel(userId, agentId, testType, baseUrl);
      }

      console.log('📨 Executing action benchmark test with channel:', testChannelId);
      const testResult = await executeActionBenchmarkTest(
        runtime,
        testType,
        userId,
        testChannelId as UUID,
        baseUrl
      );

      console.log('✅ Action benchmark test completed successfully');

      // Send success response
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          success: testResult.overallPassed,
          message: testResult.overallPassed
            ? `✅ Test "${testResult.testName}" passed! (${testResult.successfulSteps}/${testResult.totalSteps} steps)`
            : `❌ Test "${testResult.testName}" failed! (${testResult.successfulSteps}/${testResult.totalSteps} steps)`,
          data: {
            testType,
            channelId: testChannelId,
            testResult,
            timestamp: new Date().toISOString(),
          },
        })
      );
    } catch (error) {
      console.error('❌ Test execution failed:', error);

      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          success: false,
          error: error instanceof Error ? error.message : String(error),
          timestamp: new Date().toISOString(),
        })
      );
    }
  },
};

/**
 * Create a test channel for the benchmark
 */
async function createTestChannel(
  userId: UUID,
  agentId: UUID,
  testType: string,
  baseUrl?: string,
  predeterminedChannelId?: UUID
): Promise<UUID> {
  try {
    const channelPayload = {
      ...(predeterminedChannelId && { id: predeterminedChannelId }), // Include predetermined ID if provided
      name: `Action Bench Test - ${testType}`.trim(),
      server_id: DEFAULT_SERVER_ID,
      participantCentralUserIds: [userId, agentId],
      type: ChannelType.DM,
      metadata: {
        isDm: true,
        user1: userId,
        user2: agentId,
        forAgent: agentId,
        createdAt: new Date().toISOString(),
        createdByPlugin: 'action-bench',
        testType: testType,
        ...(predeterminedChannelId && { predeterminedId: predeterminedChannelId }), // Track in metadata
      },
    };

    console.log(
      '📦 Channel payload:',
      predeterminedChannelId
        ? `Using predetermined ID: ${predeterminedChannelId}`
        : 'Auto-generating ID',
      channelPayload
    );

    // Use the base URL passed from frontend (from window.location.origin)
    // This is much cleaner and more reliable than trying to detect from headers
    const serverUrl = baseUrl || 'http://localhost:3000'; // Fallback if not provided

    console.log(
      '🌐 Using base URL for channel creation:',
      serverUrl,
      baseUrl ? '(from frontend)' : '(fallback)'
    );
    const response = await fetch(`${serverUrl}/api/messaging/central-channels`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(channelPayload),
    });

    if (!response.ok) {
      throw new Error(`Failed to create channel: ${response.statusText}`);
    }

    const channel = await response.json();
    const createdChannelId = (channel as any).data.id as UUID;

    console.log('✅ Created new channel:', JSON.stringify(channel, null, 2));

    // Verify the channel was created with our predetermined ID (if provided)
    if (predeterminedChannelId && createdChannelId !== predeterminedChannelId) {
      console.warn('⚠️ Channel created with different ID than requested:', {
        requested: predeterminedChannelId,
        actual: createdChannelId,
      });
    }

    return predeterminedChannelId || createdChannelId;
  } catch (error) {
    console.error('❌ Failed to create channel:', error);
    throw error;
  }
}

/**
 * Execute an action benchmark test using the test definition system
 */
async function executeActionBenchmarkTest(
  runtime: IAgentRuntime,
  testId: string,
  clientId: UUID,
  channelId: UUID,
  baseUrl: string
): Promise<TestResult> {
  // Load test definitions from shared constants
  const testLoader = new ActionBenchLoader();

  const testDefinition = testLoader.getTestDefinition(testId);
  if (!testDefinition) {
    throw new Error(`Test definition not found for testId: ${testId}`);
  }

  console.log(
    `🚀 Starting action benchmark test: ${testDefinition.name} (${testDefinition.steps.length} steps)`
  );

  // Initialize evaluator and result tracking
  const evaluator = new ActionBenchEvaluator(runtime);
  const stepResults: StepResult[] = [];

  return new Promise<TestResult>((resolve, reject) => {
    let currentStepIndex = 0;
    let socket: any = null;

    const cleanup = () => {
      if (socket) {
        socket.disconnect();
      }
    };

    const processStep = async (stepIndex: number) => {
      if (stepIndex >= testDefinition.steps.length) {
        // All steps completed
        const finalResult: TestResult = {
          testId: testDefinition.testId,
          testName: testDefinition.name,
          totalSteps: testDefinition.steps.length,
          successfulSteps: stepResults.filter((r) => r.passed).length,
          successRate: stepResults.filter((r) => r.passed).length / stepResults.length,
          stepResults,
          overallPassed: stepResults.every((r) => r.passed),
        };

        console.log('🏁 Action benchmark test completed:', finalResult);
        cleanup();
        resolve(finalResult);
        return;
      }

      const currentStep = testDefinition.steps[stepIndex];
      console.log(`📤 Step ${currentStep.stepId}: Sending message: "${currentStep.userMessage}"`);

      // Send the step message
      await sendStepMessage(currentStep.userMessage, channelId, clientId, baseUrl);
    };

    const sendStepMessage = async (
      message: string,
      channelId: UUID,
      clientId: UUID,
      baseUrl: string
    ) => {
      try {
        const serverUrl = baseUrl;
        console.log('🔌 Connecting to Socket.IO server:', serverUrl);

        socket = io(serverUrl, {
          autoConnect: true,
          reconnection: true,
        });

        socket.on('connect', async () => {
          console.log('✅ Socket connected:', socket.id);

          try {
            const messageId = uuidv4();
            console.log('🔗 Joining channel room:', channelId);

            // First, join the room
            socket.emit('message', {
              type: SOCKET_MESSAGE_TYPE.ROOM_JOINING,
              payload: {
                channelId: channelId,
                roomId: channelId,
                entityId: clientId,
              },
            });

            // Then send the message after a short delay
            setTimeout(() => {
              socket.emit('message', {
                type: SOCKET_MESSAGE_TYPE.SEND_MESSAGE,
                payload: {
                  entityId: clientId,
                  senderId: clientId,
                  senderName: 'QA',
                  message: message,
                  channelId: channelId,
                  roomId: channelId,
                  serverId: DEFAULT_SERVER_ID,
                  messageId: messageId,
                  source: 'action-bench-plugin',
                  attachments: [],
                  metadata: {
                    testStep: currentStepIndex + 1,
                    timestamp: Date.now(),
                  },
                },
              });
            }, 500);

            console.log('📤 Message sent, waiting for agent response...');
          } catch (error) {
            console.error('❌ Error sending message:', error);
            cleanup();
            reject(error);
          }
        });

        // Listen for messageBroadcast events (both user and agent messages)
        socket.on('messageBroadcast', async (data: any) => {
          try {
            const {
              senderId,
              senderName,
              text,
              roomId: messageChannelId,
              actions,
              rawMessage,
            } = data;

            console.log('######### DATA', data);

            // Only process messages from our agent in our test channel
            if (senderId !== runtime.agentId || messageChannelId !== channelId) {
              return;
            }

            console.log('📨 Agent message received:', {
              senderId,
              text,
              actions,
              actionStatus: rawMessage?.actionStatus,
            });

            const currentStep = testDefinition.steps[currentStepIndex];

            // Only process completed actions or messages without actions
            const actionStatus = rawMessage?.actionStatus;
            const isActionMessage = rawMessage?.type === 'agent_action';

            if (isActionMessage && actionStatus === 'executing') {
              console.log('⏳ Skipping executing action, waiting for completion...');
              return;
            }

            // Check if step is complete
            const isStepComplete = isStepCompleted(actions);

            if (isStepComplete) {
              console.log('✅ Step completed, evaluating...');

              // Extract all actions collected for this step (don't add new ones here)
              console.log('🎯 Final collected actions for step:', evaluator.getCollectedActions());

              // Evaluate the step using already collected actions
              const stepResult = await evaluator.evaluateStep(currentStep, text || '');
              stepResults.push(stepResult);

              console.log(`📊 Step ${currentStep.stepId} evaluation:`, {
                passed: stepResult.passed,
                actionEval: stepResult.actionEvaluation.details,
                responseEval: stepResult.responseEvaluation?.reasoning,
              });

              // Check if this is the last step
              const isLastStep = currentStepIndex === testDefinition.steps.length - 1;
              if (isLastStep) {
                const finalResult: TestResult = {
                  testId: testDefinition.testId,
                  testName: testDefinition.name,
                  totalSteps: testDefinition.steps.length,
                  successfulSteps: stepResults.filter((r) => r.passed).length,
                  successRate: stepResults.filter((r) => r.passed).length / stepResults.length,
                  stepResults,
                  overallPassed: stepResults.every((r) => r.passed),
                };

                console.log('🏁 Action benchmark test completed:', finalResult);
                cleanup();
                resolve(finalResult);
                return;
              }

              // Move to next step
              currentStepIndex++;
              console.log(
                `➡️ Moving to step ${currentStepIndex + 1} of ${testDefinition.steps.length}`
              );

              // Reset evaluator for next step
              evaluator.reset();

              // Disconnect current socket and process next step
              socket.disconnect();
              setTimeout(() => processStep(currentStepIndex), 1000); // Small delay between steps
            } else {
              // Step not complete yet, collect completed actions only
              if (isActionMessage && actionStatus === 'completed') {
                const newActions = extractActionsFromMessage(data);
                if (newActions.length > 0) {
                  console.log('📋 Completed action collected:', newActions);
                  // Add actions to evaluator's collection
                  evaluator.addActions(newActions);
                }
              } else if (!isActionMessage) {
                // Regular message (not an action), might be final response
                console.log('💬 Regular message received:', text);
              }
            }
          } catch (error) {
            console.error('❌ Error processing agent response:', error);
            cleanup();
            reject(error);
          }
        });

        socket.on('disconnect', (reason: string) => {
          console.log('🔌 Socket disconnected:', reason);
        });

        socket.on('connect_error', (error: Error) => {
          console.error('❌ Socket connection error:', error);
          cleanup();
          reject(error);
        });
      } catch (error) {
        console.error('❌ Error in sendStepMessage:', error);
        cleanup();
        reject(error);
      }
    };

    // Start with the first step
    processStep(0);
  });
}

/**
 * Check if a step is completed based on the actions received
 * A step is complete when:
 * 1. Agent performs MultiStepSummary action (final action)
 * 2. Agent sends message without any actions (direct response)
 */
function isStepCompleted(actions: any[]): boolean {
  // No actions means agent responded directly without performing actions
  if (!actions || actions.length === 0) {
    console.log('🔚 Step completed: No actions (direct response)');
    return true;
  }

  // Check if MultiStepSummary is present (final action)
  const hasMultiStepSummary = actions.some((action: any) => {
    const actionName = action.name || action.type || action;
    return actionName === 'MultiStepSummary' || actionName === 'MULTI_STEP_SUMMARY';
  });

  if (hasMultiStepSummary) {
    console.log('🔚 Step completed: MultiStepSummary action detected');
    return true;
  }

  console.log('⏳ Step in progress: Actions received but no completion signal');
  return false;
}

/**
 * Extract action names from agent message data
 */
function extractActionsFromMessage(messageData: any): string[] {
  const actions: string[] = [];

  if (messageData.actions && Array.isArray(messageData.actions)) {
    return messageData.actions
      .map((action: any) => {
        // Handle different action formats
        if (typeof action === 'string') {
          return action;
        }
        return action.name || action.type || String(action);
      })
      .filter(Boolean);
  }

  return actions;
}
