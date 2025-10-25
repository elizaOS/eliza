/**
 * Types for Containers Command
 */

export interface ContainersOptions {
  apiUrl?: string;
  apiKey?: string;
  json?: boolean;
}

export interface DeleteContainerOptions extends ContainersOptions {
  force?: boolean;
  projectName?: string;
}

export interface ContainerLogsOptions extends ContainersOptions {
  follow?: boolean;
  tail?: string;
  projectName?: string;
}

export interface Container {
  id: string;
  name: string;
  project_name: string;
  description?: string;
  status: string;
  created_at: string;
  updated_at: string;
  load_balancer_url?: string;
  cpu: number;
  memory: number;
  port: number;
  is_update: string;
  cloudformation_stack_name?: string;
}
