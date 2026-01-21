import {
  createUniqueUuid,
  type IAgentRuntime,
  type JsonValue,
  logger,
  type Memory,
  MemoryType,
  Service,
  type ServiceTypeName,
  stringToUuid,
  type Task,
  type TaskWorker,
  type UUID,
} from "@elizaos/core";
import type { ContactInfo, RolodexService } from "./rolodex.ts";

export interface FollowUpTask {
  entityId: UUID;
  reason: string;
  message?: string;
  priority: "high" | "medium" | "low";
  metadata?: Record<string, JsonValue | object>;
}

export interface FollowUpSuggestion {
  entityId: UUID;
  entityName: string;
  reason: string;
  daysSinceLastContact: number;
  relationshipStrength: number;
  suggestedMessage?: string;
}

export class FollowUpService extends Service {
  static serviceType = "follow_up" as const;

  capabilityDescription =
    "Task-based follow-up scheduling and management for contacts";

  private rolodexService!: RolodexService;

  constructor(runtime?: IAgentRuntime) {
    super();
    if (runtime) {
      this.runtime = runtime;
      // Wait for RolodexService to become available using service promise
      this.runtime
        .getServiceLoadPromise("rolodex" as ServiceTypeName)
        .then((service) => {
          this.rolodexService = service as RolodexService;
          logger.info(
            "[FollowUpService] Successfully acquired RolodexService via service promise",
          );
        })
        .catch((error) => {
          logger.error(
            "[FollowUpService] Failed to acquire RolodexService:",
            error instanceof Error ? error.message : String(error),
          );
          throw new Error("[FollowUpService] RolodexService is not available");
        });
    }
  }

  async initialize(runtime: IAgentRuntime): Promise<void> {
    this.runtime = runtime;

    // If rolodexService is not already initialized, wait for it
    if (!this.rolodexService) {
      this.rolodexService = (await this.runtime.getServiceLoadPromise(
        "rolodex" as ServiceTypeName,
      )) as RolodexService;
      logger.info(
        "[FollowUpService] Successfully acquired RolodexService via service promise",
      );
    }

    // Register task workers
    this.registerFollowUpWorker();
    this.registerRecurringCheckInWorker();

    logger.info("[FollowUpService] Initialized successfully");
  }

  async stop(): Promise<void> {
    // rolodexService will be cleaned up by the runtime
    logger.info("[FollowUpService] Stopped successfully");
  }

  static async start(runtime: IAgentRuntime): Promise<Service> {
    const service = new FollowUpService(runtime);
    await service.initialize(runtime);
    return service;
  }

  // Follow-up Scheduling Methods
  async scheduleFollowUp(
    entityId: UUID,
    scheduledAt: Date,
    reason: string,
    priority: "high" | "medium" | "low" = "medium",
    message?: string,
  ): Promise<Task> {
    // Ensure contact exists
    const contact = await this.rolodexService.getContact(entityId);
    if (!contact) {
      throw new Error(`Contact ${entityId} not found`);
    }

    // Create follow-up task
    const task: Task = {
      id: createUniqueUuid(this.runtime, `followup-${entityId}-${Date.now()}`),
      name: "follow_up",
      description: `Follow-up with contact: ${reason}`,
      entityId: this.runtime.agentId,
      roomId: stringToUuid(`rolodex-${this.runtime.agentId}`),
      worldId: stringToUuid(`rolodex-world-${this.runtime.agentId}`),
      tags: ["follow-up", priority, "rolodex"],
      metadata: {
        targetEntityId: entityId,
        reason,
        priority,
        message,
        scheduledAt: scheduledAt.toISOString(),
        status: "pending",
        createdAt: new Date().toISOString(),
      },
    };

    // Save task
    await this.runtime.createTask(task);

    // Update contact with next follow-up
    await this.rolodexService.updateContact(entityId, {
      customFields: {
        ...contact.customFields,
        nextFollowUpAt: scheduledAt.toISOString(),
        nextFollowUpReason: reason,
      },
    });

    logger.info(
      `[FollowUpService] Scheduled follow-up for ${entityId} at ${scheduledAt.toISOString()}`,
    );
    return task;
  }

  async getUpcomingFollowUps(
    days: number = 7,
    includeOverdue: boolean = true,
  ): Promise<Array<{ task: Task; contact: ContactInfo }>> {
    const now = Date.now();
    const futureDate = now + days * 24 * 60 * 60 * 1000;

    // Get all follow-up tasks
    const tasks = await this.runtime.getTasks({
      entityId: this.runtime.agentId,
      tags: ["follow-up"],
    });

    const upcomingFollowUps: Array<{ task: Task; contact: ContactInfo }> = [];

    for (const task of tasks) {
      if (task.metadata?.status !== "pending") continue;

      const scheduledAt = task.metadata?.scheduledAt
        ? new Date(task.metadata.scheduledAt as string).getTime()
        : 0;

      // Check if task is within the time range
      if (includeOverdue && scheduledAt < now) {
        // Overdue task
      } else if (scheduledAt >= now && scheduledAt <= futureDate) {
        // Upcoming task
      } else {
        continue;
      }

      // Get contact info
      const targetEntityId = task.metadata?.targetEntityId as UUID;
      if (targetEntityId) {
        const contact = await this.rolodexService.getContact(targetEntityId);
        if (contact) {
          upcomingFollowUps.push({ task, contact });
        }
      }
    }

    // Sort by scheduled date
    upcomingFollowUps.sort((a, b) => {
      const aScheduled = a.task.metadata?.scheduledAt
        ? new Date(a.task.metadata.scheduledAt as string).getTime()
        : 0;
      const bScheduled = b.task.metadata?.scheduledAt
        ? new Date(b.task.metadata.scheduledAt as string).getTime()
        : 0;
      return aScheduled - bScheduled;
    });

    return upcomingFollowUps;
  }

  async completeFollowUp(taskId: UUID, notes?: string): Promise<void> {
    try {
      const task = await this.runtime.getTask(taskId);
      if (!task) {
        throw new Error(`Task ${taskId} not found`);
      }

      // Update task metadata
      await this.runtime.updateTask(taskId, {
        metadata: {
          ...task.metadata,
          status: "completed",
          completedAt: new Date().toISOString(),
          completionNotes: notes,
        },
      });

      // Clear next follow-up from contact
      const targetEntityId = task.metadata?.targetEntityId as UUID;
      if (targetEntityId) {
        const contact = await this.rolodexService.getContact(targetEntityId);
        if (contact) {
          const customFields = { ...contact.customFields };
          delete customFields.nextFollowUpAt;
          delete customFields.nextFollowUpReason;

          await this.rolodexService.updateContact(targetEntityId, {
            customFields,
          });
        }
      }
    } catch (error) {
      logger.error(
        "[FollowUpService] Error completing follow-up:",
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }

    logger.info(`[FollowUpService] Completed follow-up task ${taskId}`);
  }

  async snoozeFollowUp(taskId: UUID, newDate: Date): Promise<void> {
    try {
      const task = await this.runtime.getTask(taskId);
      if (!task) {
        throw new Error(`Task ${taskId} not found`);
      }

      // Update task metadata
      await this.runtime.updateTask(taskId, {
        metadata: {
          ...task.metadata,
          scheduledAt: newDate.toISOString(),
          snoozedAt: new Date().toISOString(),
          originalScheduledAt:
            task.metadata?.scheduledAt || task.metadata?.createdAt,
        },
      });

      // Update contact
      const targetEntityId = task.metadata?.targetEntityId as UUID;
      if (targetEntityId) {
        const contact = await this.rolodexService.getContact(targetEntityId);
        if (contact) {
          await this.rolodexService.updateContact(targetEntityId, {
            customFields: {
              ...contact.customFields,
              nextFollowUpAt: newDate.toISOString(),
            },
          });
        }
      }

      logger.info(
        `[FollowUpService] Snoozed follow-up ${taskId} to ${newDate.toISOString()}`,
      );
    } catch (error) {
      logger.error(
        "[FollowUpService] Error snoozing follow-up:",
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  // Smart Follow-up Suggestions
  async getFollowUpSuggestions(): Promise<FollowUpSuggestion[]> {
    // Get all contacts
    const contacts = await this.rolodexService.searchContacts({});

    const insights = await this.rolodexService.getRelationshipInsights(
      this.runtime.agentId,
    );
    const needsAttentionById = new Map(
      insights.needsAttention.map((item) => [item.entity.id, item]),
    );
    const candidates = contacts.filter((contact) => {
      const needsAttention = needsAttentionById.get(contact.entityId);
      return Boolean(needsAttention && needsAttention.daysSinceContact > 14);
    });

    const suggestionResults: Array<FollowUpSuggestion | null> =
      await Promise.all(
        candidates.map(async (contact) => {
          const entity = await this.runtime.getEntityById(contact.entityId);
          if (!entity) return null;

          const needsAttention = needsAttentionById.get(contact.entityId);
          if (!needsAttention) return null;

          // Get relationship analytics
          const analytics = await this.rolodexService.analyzeRelationship(
            this.runtime.agentId,
            contact.entityId,
          );

          if (!analytics) {
            return null;
          }

          return {
            entityId: contact.entityId,
            entityName: entity.names[0] || "Unknown",
            reason: this.generateFollowUpReason(
              contact.categories,
              needsAttention.daysSinceContact,
              analytics.strength,
            ),
            daysSinceLastContact: needsAttention.daysSinceContact,
            relationshipStrength: analytics.strength,
            suggestedMessage: this.generateFollowUpMessage(
              entity.names[0],
              contact.categories,
              needsAttention.daysSinceContact,
            ),
          };
        }),
      );

    const suggestions = suggestionResults.filter(
      (suggestion): suggestion is FollowUpSuggestion => suggestion !== null,
    );

    // Sort by priority (high relationship strength + long time since contact)
    suggestions.sort((a, b) => {
      const scoreA = (a.relationshipStrength / 100) * a.daysSinceLastContact;
      const scoreB = (b.relationshipStrength / 100) * b.daysSinceLastContact;
      return scoreB - scoreA;
    });

    return suggestions.slice(0, 10); // Return top 10 suggestions
  }

  // Task Workers
  private registerFollowUpWorker(): void {
    const worker: TaskWorker = {
      name: "follow_up",
      validate: async (_runtime: IAgentRuntime, _message: Memory) => {
        // This validate function is for action/evaluator use, not for task execution
        return true;
      },
      execute: async (
        runtime: IAgentRuntime,
        _options: { [key: string]: JsonValue | object },
        task: Task,
      ) => {
        try {
          const targetEntityId = task.metadata?.targetEntityId as UUID;
          const message =
            (task.metadata?.message as string) || "Time for a follow-up!";

          // Get entity
          const entity = await runtime.getEntityById(targetEntityId);
          if (!entity) {
            logger.warn(
              `[FollowUpService] Entity ${targetEntityId} not found for follow-up`,
            );
            return;
          }

          // Create a follow-up memory/reminder
          const memory: Memory = {
            id: createUniqueUuid(runtime, `followup-memory-${Date.now()}`),
            entityId: runtime.agentId,
            agentId: runtime.agentId,
            roomId: stringToUuid(`rolodex-${runtime.agentId}`),
            content: {
              text: `Follow-up reminder: ${entity.names[0]} - ${task.metadata?.reason || "Check in"}. ${message}`,
              type: "follow_up_reminder",
            },
            metadata: {
              type: MemoryType.CUSTOM,
              source: "rolodex",
              targetEntityId: targetEntityId as string,
              taskId: (task.id ?? "") as string,
              priority: (task.metadata?.priority as string) ?? "medium",
            },
            createdAt: Date.now(),
          };

          // Save the reminder
          await runtime.createMemory(memory, "reminders");

          // Emit follow-up event - cast to avoid event type checking
          await (
            runtime as {
              emitEvent: (
                event: string,
                payload: Record<string, JsonValue | object>,
              ) => Promise<void>;
            }
          ).emitEvent("follow_up:due", {
            taskId: task.id ?? "",
            taskName: task.name ?? "",
            entityId: entity.id ?? "",
            message: message ?? "",
          });

          logger.info(
            `[FollowUpService] Executed follow-up for ${entity.names[0]}`,
          );
        } catch (error) {
          logger.error(
            "[FollowUpService] Error executing follow-up:",
            error instanceof Error ? error.message : String(error),
          );
          throw error;
        }
      },
    };

    this.runtime.registerTaskWorker(worker);
  }

  private registerRecurringCheckInWorker(): void {
    const worker: TaskWorker = {
      name: "recurring_check_in",
      validate: async (_runtime: IAgentRuntime, _message: Memory) => {
        return true;
      },
      execute: async (
        runtime: IAgentRuntime,
        options: { [key: string]: JsonValue | object },
        task: Task,
      ) => {
        try {
          // Execute the check-in (similar to follow-up)
          const followUpWorker = runtime.getTaskWorker("follow_up");
          if (followUpWorker) {
            await followUpWorker.execute(runtime, options, task);
          }

          // Schedule next occurrence if updateInterval is set
          if (task.metadata?.updateInterval && task.id) {
            const updateInterval = task.metadata.updateInterval as number;
            const nextDate = new Date(Date.now() + updateInterval);

            await runtime.updateTask(task.id, {
              metadata: {
                ...task.metadata,
                scheduledAt: nextDate.toISOString(),
                lastExecuted: new Date().toISOString(),
              },
            });

            logger.info(
              `[FollowUpService] Scheduled next check-in for ${nextDate.toISOString()}`,
            );
          }
        } catch (error) {
          logger.error(
            "[FollowUpService] Error executing recurring check-in:",
            error instanceof Error ? error.message : String(error),
          );
          throw error;
        }
      },
    };

    this.runtime.registerTaskWorker(worker);
  }

  // Helper Methods
  private generateFollowUpReason(
    categories: string[],
    daysSince: number,
    relationshipStrength: number,
  ): string {
    if (categories.includes("family") && daysSince > 30) {
      return "It's been over a month since you checked in with family";
    }

    if (categories.includes("friend") && relationshipStrength > 70) {
      return "Maintain this strong friendship with regular contact";
    }

    if (categories.includes("colleague") && daysSince > 60) {
      return "Professional relationships benefit from periodic check-ins";
    }

    if (categories.includes("vip")) {
      return "VIP contact - priority follow-up recommended";
    }

    return `No contact for ${daysSince} days`;
  }

  private generateFollowUpMessage(
    name: string,
    categories: string[],
    _daysSince: number,
  ): string {
    if (categories.includes("family")) {
      return `Hey ${name}, thinking of you! How have you been?`;
    }

    if (categories.includes("friend")) {
      return `Hi ${name}! It's been a while - would love to catch up!`;
    }

    if (categories.includes("colleague")) {
      return `Hi ${name}, hope you're doing well. Any updates on your projects?`;
    }

    return `Hi ${name}, just wanted to check in and see how you're doing!`;
  }

  // Bulk Operations
  async scheduleMultipleFollowUps(
    followUps: Array<{
      entityId: UUID;
      scheduledAt: Date;
      reason: string;
      priority?: "high" | "medium" | "low";
      message?: string;
    }>,
  ): Promise<Task[]> {
    const tasks: Task[] = [];

    for (const followUp of followUps) {
      const task = await this.scheduleFollowUp(
        followUp.entityId,
        followUp.scheduledAt,
        followUp.reason,
        followUp.priority || "medium",
        followUp.message,
      );
      tasks.push(task);
    }

    logger.info(`[FollowUpService] Scheduled ${tasks.length} follow-ups`);
    return tasks;
  }
}
