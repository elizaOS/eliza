import type {
  CreateLifeOpsWorkflowRequest,
  LifeOpsWorkflowRecord,
  LifeOpsWorkflowRun,
  UpdateLifeOpsWorkflowRequest,
} from "../contracts/index.js";
import { matchesCalendarEventEndedFilters } from "./domains/workflows-service.js";

export { matchesCalendarEventEndedFilters };

export interface LifeOpsWorkflowService {
  listWorkflows(): Promise<LifeOpsWorkflowRecord[]>;
  getWorkflow(workflowId: string): Promise<LifeOpsWorkflowRecord>;
  createWorkflow(
    request: CreateLifeOpsWorkflowRequest,
  ): Promise<LifeOpsWorkflowRecord>;
  updateWorkflow(
    workflowId: string,
    request: UpdateLifeOpsWorkflowRequest,
  ): Promise<LifeOpsWorkflowRecord>;
  runWorkflow(
    workflowId: string,
    request?: { now?: string; confirmBrowserActions?: boolean },
  ): Promise<LifeOpsWorkflowRun>;
}
