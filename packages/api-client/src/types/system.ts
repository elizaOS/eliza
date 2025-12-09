export interface SystemEnvironment {
  nodeVersion: string;
  platform: string;
  environment: 'development' | 'production' | 'test';
  features: {
    authentication: boolean;
    tee: boolean;
    plugins: string[];
  };
  configuration: Record<string, unknown>;
}

export interface LocalEnvironmentUpdateParams {
  variables: Record<string, string>;
  merge?: boolean;
}

export interface LocalEnvironmentContentParams {
  content: Record<string, string>;
}

export interface LogEntry {
  level: number;
  time: number;
  msg: string;
  [key: string]: string | number | boolean | null | undefined;
}

export interface GlobalLogsResponse {
  logs?: LogEntry[];
  count?: number;
  total?: number;
  requestedLevel?: string;
  level?: string;
  levels?: string[];
}
