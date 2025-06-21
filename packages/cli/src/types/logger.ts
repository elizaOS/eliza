/**
 * Logger configuration interface shared across CLI commands
 */
export interface LoggerConfig {
  level: string;
  transport: 'console' | 'file';
  file?: string;
  jsonFormat?: boolean;
} 