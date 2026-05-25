export type GenericValue = string | object | number | boolean | undefined | null;

export type NodeParameterValue = string | number | boolean | undefined | null;

export type NodeParameterValueType =
  | NodeParameterValue
  | INodeParameters
  | NodeParameterValue[]
  | INodeParameters[]
  | Record<string, unknown>
  | Array<Record<string, unknown>>;

export interface INodeParameters {
  [key: string]: NodeParameterValueType;
}

export type NodePropertyTypes =
  | 'boolean'
  | 'button'
  | 'collection'
  | 'color'
  | 'dateTime'
  | 'fixedCollection'
  | 'hidden'
  | 'json'
  | 'notice'
  | 'multiOptions'
  | 'number'
  | 'options'
  | 'string'
  | 'credentialsSelect'
  | 'resourceLocator'
  | 'curlImport'
  | 'resourceMapper'
  | 'filter'
  | 'assignmentCollection'
  | 'credentials'
  | 'workflowSelector';

export interface INodePropertyOptions {
  name: string;
  value?: string | number | boolean;
  action?: string;
  description?: string;
  displayName?: string;
}

export interface INodePropertyCollection {
  displayName?: string;
  name: string;
  values: INodeProperties[];
}

export interface INodeProperties {
  displayName: string;
  name: string;
  type: NodePropertyTypes;
  default: NodeParameterValueType;
  description?: string;
  hint?: string;
  options?: Array<INodePropertyOptions | INodeProperties | INodePropertyCollection>;
  placeholder?: string;
  required?: boolean;
  typeOptions?: Record<string, unknown>;
  displayOptions?: unknown;
  routing?: unknown;
}

export interface INodeCredentialsDetails {
  id: string | null;
  name: string;
  __aiGatewayManaged?: boolean;
}

export interface INodeCredentials {
  [key: string]: INodeCredentialsDetails;
}

export type OnError = 'continueErrorOutput' | 'continueRegularOutput' | 'stopWorkflow';

export interface INode {
  id: string;
  name: string;
  typeVersion: number;
  type: string;
  position: [number, number];
  disabled?: boolean;
  notes?: string;
  notesInFlow?: boolean;
  retryOnFail?: boolean;
  maxTries?: number;
  waitBetweenTries?: number;
  alwaysOutputData?: boolean;
  executeOnce?: boolean;
  onError?: OnError;
  continueOnFail?: boolean;
  parameters: INodeParameters;
  credentials?: INodeCredentials;
  webhookId?: string;
  extendsCredential?: string;
  rewireOutputLogTo?: string;
  forceCustomOperation?: {
    resource: string;
    operation: string;
  };
}

export type NodeGroupType =
  | 'input'
  | 'output'
  | 'organization'
  | 'schedule'
  | 'transform'
  | 'trigger';

export interface INodeTypeDescription {
  displayName: string;
  name: string;
  group: NodeGroupType[];
  version: number | number[];
  description: string;
  defaults: {
    name: string;
    color?: string;
  };
  inputs: unknown[] | string[] | string;
  outputs: unknown[] | string[] | string;
  credentials?: Array<{
    name: string;
    required?: boolean;
    displayOptions?: unknown;
  }>;
  properties: INodeProperties[];
  icon?: string;
  iconUrl?: string;
  polling?: boolean;
  triggerPanel?: unknown;
  webhooks?: Array<Record<string, unknown>>;
}

export namespace WorkflowSettings {
  export type CallerPolicy = 'workflowsFromSameOwner' | 'workflowsFromAList' | 'any';
  export type SaveDataExecution = 'DEFAULT' | 'all' | 'none';
  export type RedactionPolicy = 'none' | 'mask';
}

export type WorkflowSettingsBinaryMode = 'separate' | 'combined';

export interface IWorkflowSettings {
  timezone?: 'DEFAULT' | string;
  errorWorkflow?: 'DEFAULT' | string;
  callerIds?: string;
  callerPolicy?: WorkflowSettings.CallerPolicy;
  saveDataErrorExecution?: WorkflowSettings.SaveDataExecution;
  saveDataSuccessExecution?: WorkflowSettings.SaveDataExecution;
  saveManualExecutions?: 'DEFAULT' | boolean;
  saveExecutionProgress?: 'DEFAULT' | boolean;
  executionTimeout?: number;
  executionOrder?: 'v0' | 'v1';
  binaryMode?: WorkflowSettingsBinaryMode;
  timeSavedPerExecution?: number;
  timeSavedMode?: 'fixed' | 'dynamic';
  availableInMCP?: boolean;
  credentialResolverId?: string;
  redactionPolicy?: WorkflowSettings.RedactionPolicy;
}
