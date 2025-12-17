import {
  PluginEvents,
  EventType,
  MessagePayload,
  InvokePayload,
  WorldPayload,
  EntityPayload,
  ActionEventPayload,
  EvaluatorEventPayload,
  RunEventPayload,
  logger,
} from '@elizaos/core';
import {
  reactionReceivedHandler,
  postGeneratedHandler,
  handleServerSync,
  syncSingleUser,
  controlMessageHandler,
} from './handlers';

export const listeners: PluginEvents = {
  [EventType.REACTION_RECEIVED]: [
    async (payload: MessagePayload) => {
      await reactionReceivedHandler(payload);
    },
  ],

  [EventType.POST_GENERATED]: [
    async (payload: InvokePayload) => {
      await postGeneratedHandler(payload);
    },
  ],

  [EventType.MESSAGE_SENT]: [
    async (payload: MessagePayload) => {
      payload.runtime.logger.debug(`[Bootstrap] Message sent: ${payload.message.content.text}`);
    },
  ],

  [EventType.WORLD_JOINED]: [
    async (payload: WorldPayload) => {
      await handleServerSync(payload);
    },
  ],

  [EventType.WORLD_CONNECTED]: [
    async (payload: WorldPayload) => {
      await handleServerSync(payload);
    },
  ],

  [EventType.ENTITY_JOINED]: [
    async (payload: EntityPayload) => {
      payload.runtime.logger.debug(
        `[Bootstrap] ENTITY_JOINED event received for entity ${payload.entityId}`
      );

      if (!payload.worldId) {
        payload.runtime.logger.error('[Bootstrap] No worldId provided for entity joined');
        return;
      }
      if (!payload.roomId) {
        payload.runtime.logger.error('[Bootstrap] No roomId provided for entity joined');
        return;
      }
      if (!payload.metadata?.type) {
        payload.runtime.logger.error('[Bootstrap] No type provided for entity joined');
        return;
      }

      await syncSingleUser(
        payload.entityId,
        payload.runtime,
        payload.worldId,
        payload.roomId,
        payload.metadata.type as any,
        payload.source
      );
    },
  ],

  [EventType.ENTITY_LEFT]: [
    async (payload: EntityPayload) => {
      try {
        // Update entity to inactive
        const entity = await payload.runtime.getEntityById(payload.entityId);
        if (entity) {
          entity.metadata = {
            ...entity.metadata,
            status: 'INACTIVE',
            leftAt: Date.now(),
          };
          await payload.runtime.updateEntity(entity);
        }
        payload.runtime.logger.info(
          `[Bootstrap] User ${payload.entityId} left world ${payload.worldId}`
        );
      } catch (error: any) {
        payload.runtime.logger.error(
          '[Bootstrap] Error handling user left:',
          error instanceof Error ? error.message : String(error)
        );
      }
    },
  ],

  [EventType.ACTION_STARTED]: [
    async (payload: ActionEventPayload) => {
      try {
        // Only notify for client_chat messages
        if (payload.content?.source === 'client_chat') {
          const messageBusService = payload.runtime.getService('message-bus-service') as any;
          if (messageBusService) {
            await messageBusService.notifyActionStart(
              payload.roomId,
              payload.world,
              payload.content,
              payload.messageId
            );
          }
        }
      } catch (error) {
        logger.error(`[Bootstrap] Error sending refetch request: ${error}`);
      }
    },
    async (payload: ActionEventPayload) => {
      try {
        await payload.runtime.log({
          entityId: payload.runtime.agentId,
          roomId: payload.roomId,
          type: 'action_event',
          body: {
            runId: payload.content?.runId,
            actionId: payload.content?.actionId,
            actionName: payload.content?.actions?.[0],
            roomId: payload.roomId,
            messageId: payload.messageId,
            timestamp: Date.now(),
            planStep: payload.content?.planStep,
            source: 'actionHandler',
          },
        });
        logger.debug(
          `[Bootstrap] Logged ACTION_STARTED event for action ${payload.content?.actions?.[0]}`
        );
      } catch (error) {
        logger.error(`[Bootstrap] Failed to log ACTION_STARTED event: ${error}`);
      }
    },
  ],

  [EventType.ACTION_COMPLETED]: [
    async (payload: ActionEventPayload) => {
      try {
        // Only notify for client_chat messages
        if (payload.content?.source === 'client_chat') {
          const messageBusService = payload.runtime.getService('message-bus-service') as any;
          if (messageBusService) {
            await messageBusService.notifyActionUpdate(
              payload.roomId,
              payload.world,
              payload.content,
              payload.messageId
            );
          }
        }
      } catch (error) {
        logger.error(`[Bootstrap] Error sending refetch request: ${error}`);
      }
    },
  ],

  [EventType.EVALUATOR_STARTED]: [
    async (payload: EvaluatorEventPayload) => {
      logger.debug(
        `[Bootstrap] Evaluator started: ${payload.evaluatorName} (${payload.evaluatorId})`
      );
    },
  ],

  [EventType.EVALUATOR_COMPLETED]: [
    async (payload: EvaluatorEventPayload) => {
      const status = payload.error ? `failed: ${payload.error.message}` : 'completed';
      logger.debug(
        `[Bootstrap] Evaluator ${status}: ${payload.evaluatorName} (${payload.evaluatorId})`
      );
    },
  ],

  [EventType.RUN_STARTED]: [
    async (payload: RunEventPayload) => {
      try {
        await payload.runtime.log({
          entityId: payload.entityId,
          roomId: payload.roomId,
          type: 'run_event',
          body: {
            runId: payload.runId,
            status: payload.status,
            messageId: payload.messageId,
            roomId: payload.roomId,
            entityId: payload.entityId,
            startTime: payload.startTime,
            source: payload.source || 'unknown',
          },
        });
        logger.debug(`[Bootstrap] Logged RUN_STARTED event for run ${payload.runId}`);
      } catch (error) {
        logger.error(`[Bootstrap] Failed to log RUN_STARTED event: ${error}`);
      }
    },
  ],

  [EventType.RUN_ENDED]: [
    async (payload: RunEventPayload) => {
      try {
        await payload.runtime.log({
          entityId: payload.entityId,
          roomId: payload.roomId,
          type: 'run_event',
          body: {
            runId: payload.runId,
            status: payload.status,
            messageId: payload.messageId,
            roomId: payload.roomId,
            entityId: payload.entityId,
            startTime: payload.startTime,
            endTime: payload.endTime,
            duration: payload.duration,
            error: payload.error,
            source: payload.source || 'unknown',
          },
        });
        logger.debug(
          `[Bootstrap] Logged RUN_ENDED event for run ${payload.runId} with status ${payload.status}`
        );
      } catch (error) {
        logger.error(`[Bootstrap] Failed to log RUN_ENDED event: ${error}`);
      }
    },
  ],

  [EventType.RUN_TIMEOUT]: [
    async (payload: RunEventPayload) => {
      try {
        await payload.runtime.log({
          entityId: payload.entityId,
          roomId: payload.roomId,
          type: 'run_event',
          body: {
            runId: payload.runId,
            status: payload.status,
            messageId: payload.messageId,
            roomId: payload.roomId,
            entityId: payload.entityId,
            startTime: payload.startTime,
            endTime: payload.endTime,
            duration: payload.duration,
            error: payload.error,
            source: payload.source || 'unknown',
          },
        });
        logger.debug(`[Bootstrap] Logged RUN_TIMEOUT event for run ${payload.runId}`);
      } catch (error) {
        logger.error(`[Bootstrap] Failed to log RUN_TIMEOUT event: ${error}`);
      }
    },
  ],

  CONTROL_MESSAGE: [controlMessageHandler],
};
