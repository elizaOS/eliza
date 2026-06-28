import type {
  CompleteLifeOpsOccurrenceRequest,
  CreateLifeOpsDefinitionRequest,
  LifeOpsDefinitionRecord,
  LifeOpsOccurrenceView,
  SnoozeLifeOpsOccurrenceRequest,
  UpdateLifeOpsDefinitionRequest,
} from "../contracts/index.js";
import {
  type DefinitionsDeps,
  DefinitionsDomain,
} from "./domains/definitions-service.js";
import type {
  Constructor,
  LifeOpsServiceBase,
  MixinClass,
} from "./service-mixin-core.js";

export interface LifeOpsDefinitionService {
  listDefinitions(): Promise<LifeOpsDefinitionRecord[]>;
  getDefinition(definitionId: string): Promise<LifeOpsDefinitionRecord>;
  createDefinition(
    request: CreateLifeOpsDefinitionRequest,
  ): Promise<LifeOpsDefinitionRecord>;
  updateDefinition(
    definitionId: string,
    request: UpdateLifeOpsDefinitionRequest,
  ): Promise<LifeOpsDefinitionRecord>;
  deleteDefinition(definitionId: string): Promise<void>;
  completeOccurrence(
    occurrenceId: string,
    request: CompleteLifeOpsOccurrenceRequest,
    now?: Date,
  ): Promise<LifeOpsOccurrenceView>;
  skipOccurrence(
    occurrenceId: string,
    now?: Date,
  ): Promise<LifeOpsOccurrenceView>;
  snoozeOccurrence(
    occurrenceId: string,
    request: SnoozeLifeOpsOccurrenceRequest,
    now?: Date,
  ): Promise<LifeOpsOccurrenceView>;
}

export function withDefinitions<TBase extends Constructor<LifeOpsServiceBase>>(
  Base: TBase,
): MixinClass<TBase, LifeOpsDefinitionService> {
  class LifeOpsDefinitionServiceMixin extends Base {
    // `this` (a LifeOpsServiceBase subclass) satisfies LifeOpsContext.
    // Public (not private) to avoid TS4094 on the re-exported mixin class.
    readonly definitionsDomain = new DefinitionsDomain(this, {
      getDefinitionRecord: (...args) =>
        (this as unknown as DefinitionsDeps).getDefinitionRecord(...args),
      ensureGoalExists: (...args) =>
        (this as unknown as DefinitionsDeps).ensureGoalExists(...args),
      syncReminderPlan: (...args) =>
        (this as unknown as DefinitionsDeps).syncReminderPlan(...args),
      syncGoalLink: (...args) =>
        (this as unknown as DefinitionsDeps).syncGoalLink(...args),
      refreshDefinitionOccurrences: (...args) =>
        (this as unknown as DefinitionsDeps).refreshDefinitionOccurrences(
          ...args,
        ),
      syncNativeAppleReminderForDefinition: (...args) =>
        (
          this as unknown as DefinitionsDeps
        ).syncNativeAppleReminderForDefinition(...args),
      syncWebsiteAccessState: (...args) =>
        (this as unknown as DefinitionsDeps).syncWebsiteAccessState(...args),
      getFreshOccurrence: (...args) =>
        (this as unknown as DefinitionsDeps).getFreshOccurrence(...args),
      awardWebsiteAccessGrant: (...args) =>
        (this as unknown as DefinitionsDeps).awardWebsiteAccessGrant(...args),
      resolveReminderEscalation: (...args) =>
        (this as unknown as DefinitionsDeps).resolveReminderEscalation(...args),
    });

    listDefinitions(): Promise<LifeOpsDefinitionRecord[]> {
      return this.definitionsDomain.listDefinitions();
    }

    getDefinition(definitionId: string): Promise<LifeOpsDefinitionRecord> {
      return this.definitionsDomain.getDefinition(definitionId);
    }

    createDefinition(
      request: CreateLifeOpsDefinitionRequest,
    ): Promise<LifeOpsDefinitionRecord> {
      return this.definitionsDomain.createDefinition(request);
    }

    updateDefinition(
      definitionId: string,
      request: UpdateLifeOpsDefinitionRequest,
    ): Promise<LifeOpsDefinitionRecord> {
      return this.definitionsDomain.updateDefinition(definitionId, request);
    }

    deleteDefinition(definitionId: string): Promise<void> {
      return this.definitionsDomain.deleteDefinition(definitionId);
    }

    completeOccurrence(
      occurrenceId: string,
      request: CompleteLifeOpsOccurrenceRequest,
      now?: Date,
    ): Promise<LifeOpsOccurrenceView> {
      return this.definitionsDomain.completeOccurrence(
        occurrenceId,
        request,
        now,
      );
    }

    skipOccurrence(
      occurrenceId: string,
      now?: Date,
    ): Promise<LifeOpsOccurrenceView> {
      return this.definitionsDomain.skipOccurrence(occurrenceId, now);
    }

    snoozeOccurrence(
      occurrenceId: string,
      request: SnoozeLifeOpsOccurrenceRequest,
      now?: Date,
    ): Promise<LifeOpsOccurrenceView> {
      return this.definitionsDomain.snoozeOccurrence(
        occurrenceId,
        request,
        now,
      );
    }
  }

  return LifeOpsDefinitionServiceMixin as unknown as MixinClass<
    TBase,
    LifeOpsDefinitionService
  >;
}
