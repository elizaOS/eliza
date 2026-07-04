/**
 * Task-definition service mixin: declares the definition/occurrence service
 * surface and the `withDefinitions` mixin that composes the definitions domain's
 * CRUD, completion, and snooze methods onto the LifeOpsService base.
 */
import type {
  CompleteLifeOpsOccurrenceRequest,
  CreateLifeOpsDefinitionRequest,
  LifeOpsDefinitionRecord,
  LifeOpsOccurrenceView,
  SnoozeLifeOpsOccurrenceRequest,
  UpdateLifeOpsDefinitionRequest,
} from "../contracts/index.js";

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
