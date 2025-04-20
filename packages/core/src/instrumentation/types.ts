import { Tracer, Meter } from '@opentelemetry/api';

// Placeholder for any specific types we might need later
export interface InstrumentationConfig {
  serviceName?: string;
  otlpEndpoint?: string;
  enabled?: boolean;
}

export interface IInstrumentationService {
  readonly name: string;
  readonly capabilityDescription: string;
  instrumentationConfig: InstrumentationConfig;
  isEnabled(): boolean;
  getTracer(name?: string, version?: string): Tracer | null;
  getMeter(name?: string, version?: string): Meter | null;
  flush(): Promise<void>;
  stop(): Promise<void>;
}
