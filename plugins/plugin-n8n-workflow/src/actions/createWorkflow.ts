import {
  type Action,
  type ActionExample,
  type ActionResult,
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
  type ProviderDataRecord,
  type State,
} from '@elizaos/core';
import {
  N8N_WORKFLOW_SERVICE_TYPE,
  type N8nWorkflowService,
} from '../services/index';
import type {
  N8nConnections,
  N8nWorkflow,
  WorkflowDraft,
} from '../types/index';
import { UnsupportedIntegrationError } from '../types/index';
import { coerceClarificationRequests } from '../utils/clarification';
import { buildConversationContext } from '../utils/context';
import { classifyDraftIntent, formatActionResponse } from '../utils/generation';
import { validateN8nWorkflowIntent } from './validation';

const DRAFT_TTL_MS = 30 * 60 * 1000;

function buildFlowChain(connections: N8nConnections): string {
  const connectionNames = Object.keys(connections);
  if (connectionNames.length === 0) {
    return '';
  }

  const targets = new Set<string>();
  for (const sourceName of connectionNames) {
    for (const outputType of Object.values(connections[sourceName])) {
      for (const conns of outputType) {
        for (const conn of conns) {
          targets.add(conn.node);
        }
      }
    }
  }

  const startNodes = connectionNames.filter((n) => !targets.has(n));
  const queue = startNodes.length > 0 ? [...startNodes] : [connectionNames[0]];
  const flowParts: string[] = [];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current)) {
      continue;
    }
    visited.add(current);
    flowParts.push(current);

    const outputs = connections[current];
    if (outputs) {
      for (const outputType of Object.values(outputs)) {
        for (const conns of outputType) {
          for (const conn of conns) {
            queue.push(conn.node);
          }
        }
      }
    }
  }

  return flowParts.join(' → ');
}

function buildPreviewData(workflow: N8nWorkflow): Record<string, unknown> {
  const creds = new Set<string>();
  for (const node of workflow.nodes) {
    if (node.credentials) {
      for (const c of Object.keys(node.credentials)) {
        creds.add(c);
      }
    }
  }

  return {
    workflowName: workflow.name,
    nodes: workflow.nodes.map((n) => ({
      name: n.name,
      type: n.type.replace('n8n-nodes-base.', ''),
    })),
    flow: buildFlowChain(workflow.connections),
    credentials: [...creds],
    ...(workflow._meta?.assumptions?.length && {
      assumptions: workflow._meta.assumptions,
    }),
    ...(workflow._meta?.suggestions?.length && {
      suggestions: workflow._meta.suggestions,
    }),
  };
}

function diffNodeParams(
  before: N8nWorkflow,
  after: N8nWorkflow,
): Record<string, Record<string, unknown>> {
  const changes: Record<string, Record<string, unknown>> = {};

  for (const afterNode of after.nodes) {
    const beforeNode = before.nodes.find((n) => n.name === afterNode.name);
    const afterParams = (afterNode.parameters || {}) as Record<string, unknown>;
    const beforeParams = (beforeNode?.parameters || {}) as Record<
      string,
      unknown
    >;

    const nodeChanges: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(afterParams)) {
      if (JSON.stringify(value) !== JSON.stringify(beforeParams[key])) {
        nodeChanges[key] = value;
      }
    }

    if (Object.keys(nodeChanges).length > 0) {
      changes[afterNode.name] = nodeChanges;
    }
  }

  return changes;
}

const examples: ActionExample[][] = [
  [
    {
      name: '{{user1}}',
      content: {
        text: 'Create a workflow that sends me Stripe payment summaries every Monday via Gmail',
      },
    },
    {
      name: '{{agent}}',
      content: {
        text: "I'll create an n8n workflow that fetches Stripe payments weekly and emails you a summary via Gmail.",
        actions: ['CREATE_N8N_WORKFLOW'],
      },
    },
  ],
  [
    {
      name: '{{user1}}',
      content: {
        text: 'Build a workflow to notify me on Slack when a new GitHub issue is created',
      },
    },
    {
      name: '{{agent}}',
      content: {
        text: 'Creating a workflow that monitors GitHub for new issues and sends Slack notifications.',
        actions: ['CREATE_N8N_WORKFLOW'],
      },
    },
  ],
  [
    {
      name: '{{user1}}',
      content: {
        text: 'Set up automation to save Gmail attachments to Google Drive',
      },
    },
    {
      name: '{{agent}}',
      content: {
        text: "I'll build an n8n workflow that watches for Gmail attachments and automatically saves them to Google Drive.",
        actions: ['CREATE_N8N_WORKFLOW'],
      },
    },
  ],
  [
    {
      name: '{{user1}}',
      content: { text: 'Yes, deploy it' },
    },
    {
      name: '{{agent}}',
      content: {
        text: 'Deploying your workflow now...',
        actions: ['CREATE_N8N_WORKFLOW'],
      },
    },
  ],
  [
    {
      name: '{{user1}}',
      content: { text: 'Looks good, confirm' },
    },
    {
      name: '{{agent}}',
      content: {
        text: 'Deploying your workflow...',
        actions: ['CREATE_N8N_WORKFLOW'],
      },
    },
  ],
  [
    {
      name: '{{user1}}',
      content: { text: 'Go ahead and create it' },
    },
    {
      name: '{{agent}}',
      content: {
        text: 'Deploying your workflow...',
        actions: ['CREATE_N8N_WORKFLOW'],
      },
    },
  ],
  [
    {
      name: '{{user1}}',
      content: { text: 'Cancel the workflow' },
    },
    {
      name: '{{agent}}',
      content: {
        text: 'Workflow draft cancelled.',
        actions: ['CREATE_N8N_WORKFLOW'],
      },
    },
  ],
  [
    {
      name: '{{user1}}',
      content: { text: 'Actually, use Outlook instead of Gmail' },
    },
    {
      name: '{{agent}}',
      content: {
        text: 'Regenerating the workflow with Outlook...',
        actions: ['CREATE_N8N_WORKFLOW'],
      },
    },
  ],
  [
    {
      name: '{{user1}}',
      content: { text: 'Ok' },
    },
    {
      name: '{{agent}}',
      content: {
        text: 'Deploying your workflow...',
        actions: ['CREATE_N8N_WORKFLOW'],
      },
    },
  ],
  [
    {
      name: '{{user1}}',
      content: { text: 'Yes' },
    },
    {
      name: '{{agent}}',
      content: {
        text: 'Deploying your workflow now.',
        actions: ['CREATE_N8N_WORKFLOW'],
      },
    },
  ],
  [
    {
      name: '{{user1}}',
      content: { text: 'Do it' },
    },
    {
      name: '{{agent}}',
      content: {
        text: 'Deploying your workflow...',
        actions: ['CREATE_N8N_WORKFLOW'],
      },
    },
  ],
];

export const createWorkflowAction: Action = {
  name: 'CREATE_N8N_WORKFLOW',
  contexts: ['automation', 'connectors', 'tasks'],
  contextGate: { anyOf: ['automation', 'connectors', 'tasks'] },
  roleGate: { minRole: 'USER' },
  similes: [
    'CREATE_WORKFLOW',
    'BUILD_WORKFLOW',
    'GENERATE_WORKFLOW',
    'MAKE_AUTOMATION',
    'CREATE_AUTOMATION',
    'BUILD_N8N_WORKFLOW',
    'SETUP_WORKFLOW',
    'CONFIRM_WORKFLOW',
    'DEPLOY_WORKFLOW',
    'CANCEL_WORKFLOW',
  ],
  description:
    'Generate, preview, and deploy n8n workflows from natural language. ' +
    'Handles the full lifecycle: generate a draft, show preview, then deploy on user confirmation. ' +
    'Also handles modify/cancel of pending drafts. ' +
    'IMPORTANT: When a workflow draft is pending, this action MUST be used for ANY user response ' +
    'about the draft — including "yes", "ok", "deploy it", "cancel", or modification requests. ' +
    'Never reply with text only when a draft is pending.',
  descriptionCompressed:
    'generate, preview, deploy n8n workflow natural language handle full lifecycle: generate draft, show preview, deploy user confirmation handle modify/cancel pend draft IMPORTANT: workflow draft pend, action use user response draft includ yes, ok, deploy, cancel, modification request never reply w/ text draft pend',
  parameters: [
    {
      name: 'request',
      description:
        'Natural-language workflow request, draft modification, deployment confirmation, or cancellation request.',
      required: false,
      schema: { type: 'string' },
    },
    {
      name: 'draftAction',
      description:
        'Optional explicit operation for a pending workflow draft.',
      required: false,
      schema: {
        type: 'string',
        enum: ['generate', 'modify', 'deploy', 'cancel'],
      },
    },
  ],

  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
  ): Promise<boolean> => {
    if (!runtime.getService(N8N_WORKFLOW_SERVICE_TYPE)) {
      return false;
    }
    const draft = await runtime.getCache<WorkflowDraft>(
      `workflow_draft:${message.entityId}`,
    );
    return Boolean(draft) || validateN8nWorkflowIntent(runtime, message, state);
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    _options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const service = runtime.getService<N8nWorkflowService>(
      N8N_WORKFLOW_SERVICE_TYPE,
    );

    if (!service) {
      logger.error(
        { src: 'plugin:n8n-workflow:action:create' },
        'N8n Workflow service not available',
      );
      if (callback) {
        const text = await formatActionResponse(runtime, 'ERROR', {
          error:
            'N8n Workflow service is not available. Check N8N_API_KEY and N8N_HOST.',
        });
        await callback({ text, success: false });
      }
      return { success: false };
    }

    const content = message.content as Content;
    const userText = (content.text ?? '').trim();
    const userId = message.entityId;
    const cacheKey = `workflow_draft:${userId}`;
    const generationContext = buildConversationContext(message, state);

    try {
      let existingDraft = await runtime.getCache<WorkflowDraft>(cacheKey);

      if (
        existingDraft &&
        Date.now() - existingDraft.createdAt > DRAFT_TTL_MS
      ) {
        logger.debug(
          { src: 'plugin:n8n-workflow:action:create' },
          'Draft expired, clearing cache',
        );
        await runtime.deleteCache(cacheKey);
        existingDraft = undefined;
      }

      if (existingDraft) {
        // Guard: if the draft was created by this same message, return silently.
        // No callback = no new output for the multi-step agent to process = it stops looping.
        if (
          existingDraft.originMessageId &&
          existingDraft.originMessageId === message.id
        ) {
          logger.info(
            { src: 'plugin:n8n-workflow:action:create' },
            'Same message as draft origin — skipping',
          );
          return { success: true, data: { awaitingUserInput: true } };
        }

        const intentResult = await classifyDraftIntent(
          runtime,
          userText,
          existingDraft,
        );
        logger.info(
          { src: 'plugin:n8n-workflow:action:create' },
          `Draft intent: ${intentResult.intent} — ${intentResult.reason}`,
        );

        // If the draft was awaiting clarification and the user answered, treat "confirm" as "modify"
        // to regenerate with the user's answers instead of deploying an incomplete draft.
        const effectiveIntent =
          intentResult.intent === 'confirm' &&
          existingDraft.workflow._meta?.requiresClarification?.length
            ? 'modify'
            : intentResult.intent;

        if (effectiveIntent !== intentResult.intent) {
          logger.info(
            { src: 'plugin:n8n-workflow:action:create' },
            'Draft has pending clarification — overriding "confirm" → "modify" to regenerate with user\'s answers',
          );
        }

        switch (effectiveIntent) {
          case 'confirm': {
            const result = await service.deployWorkflow(
              existingDraft.workflow,
              userId,
            );

            // Deploy blocked — unresolved credentials
            if (result.missingCredentials.length > 0) {
              const text = await formatActionResponse(
                runtime,
                'AUTH_REQUIRED',
                {
                  connections: result.missingCredentials.map((m) => ({
                    service: m.credType,
                    ...(m.authUrl && { authUrl: m.authUrl }),
                  })),
                },
              );
              if (callback) {
                await callback({ text, success: true });
              }
              return { success: true, data: { awaitingUserInput: true } };
            }

            await runtime.deleteCache(cacheKey);

            const text = await formatActionResponse(runtime, 'DEPLOY_SUCCESS', {
              workflowName: result.name,
              workflowId: result.id,
              nodeCount: result.nodeCount,
              active: result.active,
            });
            if (callback) {
              await callback({ text, success: true });
            }
            return {
              success: true,
              data: result as unknown as ProviderDataRecord,
            };
          }

          case 'cancel': {
            await runtime.deleteCache(cacheKey);
            const text = await formatActionResponse(runtime, 'CANCELLED', {
              workflowName: existingDraft.workflow.name,
            });
            if (callback) {
              await callback({ text, success: true });
            }
            return { success: true };
          }

          case 'modify': {
            const modification = intentResult.modificationRequest || userText;
            logger.info(
              { src: 'plugin:n8n-workflow:action:create' },
              `Modifying draft: ${modification.slice(0, 100)}`,
            );

            const modifiedWorkflow = await service.modifyWorkflowDraft(
              existingDraft.workflow,
              modification,
              { userId },
            );

            const modifiedDraft: WorkflowDraft = {
              workflow: modifiedWorkflow,
              prompt: existingDraft.prompt,
              userId,
              createdAt: Date.now(),
              originMessageId: message.id,
            };
            await runtime.setCache(cacheKey, modifiedDraft);

            if (modifiedWorkflow._meta?.requiresClarification?.length) {
              const text = await formatActionResponse(
                runtime,
                'CLARIFICATION',
                {
                  questions: coerceClarificationRequests(
                    modifiedWorkflow._meta.requiresClarification,
                  ).map((c) => c.question),
                },
              );
              if (callback) {
                await callback({ text, success: true });
              }
              return { success: true, data: { awaitingUserInput: true } };
            }

            const previewData = buildPreviewData(modifiedWorkflow);
            const changes = diffNodeParams(
              existingDraft.workflow,
              modifiedWorkflow,
            );
            if (Object.keys(changes).length > 0) {
              previewData.changes = changes;
            }

            const text = await formatActionResponse(
              runtime,
              'PREVIEW',
              previewData,
            );
            if (callback) {
              await callback({ text, success: true });
            }
            return { success: true, data: { awaitingUserInput: true } };
          }

          case 'new': {
            if (!userText) {
              const text = await formatActionResponse(
                runtime,
                'EMPTY_PROMPT',
                {},
              );
              if (callback) {
                await callback({ text, success: false });
              }
              await runtime.deleteCache(cacheKey);
              return { success: false };
            }

            await runtime.deleteCache(cacheKey);
            try {
              return await generateAndPreview(
                runtime,
                service,
                generationContext,
                userId,
                cacheKey,
                message.id ?? '',
                callback,
              );
            } catch (genError) {
              logger.warn(
                { src: 'plugin:n8n-workflow:action:create' },
                `New workflow generation failed — restoring previous draft: ${genError instanceof Error ? genError.message : String(genError)}`,
              );
              await runtime.setCache(cacheKey, existingDraft);
              const text = await formatActionResponse(runtime, 'PREVIEW', {
                ...buildPreviewData(existingDraft.workflow),
                restoredAfterFailure: true,
              });
              if (callback) {
                await callback({ text, success: true });
              }
              return { success: true, data: { awaitingUserInput: true } };
            }
          }

          default: {
            logger.info(
              { src: 'plugin:n8n-workflow:action:create' },
              'Intent classification unclear — re-showing preview',
            );
            const text = await formatActionResponse(
              runtime,
              'PREVIEW',
              buildPreviewData(existingDraft.workflow),
            );
            if (callback) {
              await callback({ text, success: true });
            }
            return { success: true, data: { awaitingUserInput: true } };
          }
        }
      }

      if (!userText) {
        const text = await formatActionResponse(runtime, 'EMPTY_PROMPT', {});
        if (callback) {
          await callback({ text, success: false });
        }
        return { success: false };
      }

      return await generateAndPreview(
        runtime,
        service,
        generationContext,
        userId,
        cacheKey,
        message.id ?? '',
        callback,
      );
    } catch (error) {
      if (error instanceof UnsupportedIntegrationError) {
        const text = await formatActionResponse(
          runtime,
          'UNSUPPORTED_INTEGRATION',
          {
            unsupported: error.unsupportedServices,
            available: error.availableServices,
          },
        );
        if (callback) {
          await callback({ text, success: false });
        }
        return { success: false };
      }

      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      logger.error(
        { src: 'plugin:n8n-workflow:action:create' },
        `Failed to create workflow: ${errorMessage}`,
      );

      const text = await formatActionResponse(runtime, 'ERROR', {
        error: errorMessage,
      });
      if (callback) {
        await callback({ text, success: false });
      }
      return { success: false };
    }
  },

  examples,
};

async function generateAndPreview(
  runtime: IAgentRuntime,
  service: N8nWorkflowService,
  prompt: string,
  userId: string,
  cacheKey: string,
  messageId: string,
  callback?: HandlerCallback,
): Promise<ActionResult> {
  logger.info(
    { src: 'plugin:n8n-workflow:action:create' },
    `Generating workflow from prompt: ${prompt.slice(0, 100)}...`,
  );

  const workflow = await service.generateWorkflowDraft(prompt, { userId });

  const draft: WorkflowDraft = {
    workflow,
    prompt,
    userId,
    createdAt: Date.now(),
    originMessageId: messageId,
  };
  await runtime.setCache(cacheKey, draft);

  if (workflow._meta?.requiresClarification?.length) {
    const text = await formatActionResponse(runtime, 'CLARIFICATION', {
      questions: coerceClarificationRequests(
        workflow._meta.requiresClarification,
      ).map((c) => c.question),
    });
    if (callback) {
      await callback({ text, success: true });
    }
    return { success: true, data: { awaitingUserInput: true } };
  }

  const text = await formatActionResponse(
    runtime,
    'PREVIEW',
    buildPreviewData(workflow),
  );
  if (callback) {
    await callback({ text, success: true });
  }
  return { success: true, data: { awaitingUserInput: true } };
}
