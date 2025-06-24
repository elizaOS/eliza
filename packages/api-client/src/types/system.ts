export interface SystemEnvironment {
  nodeVersion: string;
  platform: string;
  environment: 'development' | 'production' | 'test';
  features: {
    authentication: boolean;
    tee: boolean;
    plugins: string[];
  };
  configuration: Record<string, any>;
}

export interface LocalEnvironmentUpdateParams {
  variables: Record<string, string>;
  merge?: boolean;
}
