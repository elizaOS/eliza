export interface EnvVarConfig {
  type: string;
  description: string;
  required: boolean;
  sensitive?: boolean;
  default?: string;
}
