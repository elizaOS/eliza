import {
  diag,
  DiagConsoleLogger,
  DiagLogLevel,
  Meter,
  metrics,
  trace,
  Tracer,
} from '@opentelemetry/api';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { Resource } from '@opentelemetry/resources';
import { MeterProvider } from '@opentelemetry/sdk-metrics';
import { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { elizaLogger } from '../logger';
import { IAgentRuntime, Service } from '../types';
import { IInstrumentationService, InstrumentationConfig } from './types';
let pg: typeof import('pg');

const DEFAULT_SERVICE_NAME = 'eliza-agent';

/**
 * Custom span processor that writes spans to a PostgreSQL database
 */

class PostgresSpanProcessor implements SpanProcessor {
  private pgClient: import('pg').Client | null = null;
  private isInitialized = false;
  private isConnected = false;

  constructor(connectionString: string) {
    try {
      pg = require('pg'); // CommonJS require to avoid bundlers evaluating it during build
    } catch (err) {
      elizaLogger.error(
        "❌ Failed to dynamically require 'pg'. Are you running in a non-Node environment?"
      );
      return;
    }
    elizaLogger.info(`🔄 Initializing PostgreSQL Span Processor with provided URL.`);

    if (!connectionString) {
      elizaLogger.error(
        `❌ Cannot initialize PostgreSQL Span Processor: Connection string is empty.`
      );
      return;
    }

    try {
      this.pgClient = new pg.Client({
        connectionString: connectionString,
      });

      elizaLogger.info(`🔄 Connecting to PostgreSQL...`);
      this.pgClient.connect((err) => {
        if (err) {
          elizaLogger.error(`❌ Failed to connect to PostgreSQL in constructor: ${err}`);
          this.pgClient = null;
          return;
        }

        this.isConnected = true;
        elizaLogger.info(`✅ Connected to PostgreSQL database`);

        const createTableQuery = `
                    CREATE TABLE IF NOT EXISTS traces (
                        id SERIAL PRIMARY KEY,
                        trace_id TEXT NOT NULL,
                        span_id TEXT NOT NULL,
                        parent_span_id TEXT,
                        trace_state TEXT,
                        span_name TEXT NOT NULL,
                        span_kind INTEGER,
                        start_time TIMESTAMP NOT NULL,
                        end_time TIMESTAMP NOT NULL,
                        duration_ms INTEGER NOT NULL,
                        status_code INTEGER,
                        status_message TEXT,
                        attributes JSONB,
                        events JSONB,
                        links JSONB,
                        resource JSONB,
                        agent_id TEXT,
                        session_id TEXT,
                        environment TEXT,
                        room_id TEXT,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        UNIQUE(trace_id, span_id)
                    );
                `;

        this.pgClient.query(createTableQuery, (err, result) => {
          if (err) {
            elizaLogger.error(`❌ Failed to create traces table: ${err}`);
            return;
          }

          this.isInitialized = true;
          elizaLogger.info(`✅ Traces table created or verified.`);

          const testQuery = `
                        INSERT INTO traces (
                            trace_id, span_id, span_name, start_time, end_time, duration_ms,
                            agent_id, session_id, environment, room_id
                        ) VALUES (
                            'test-connection', 'test-connection', 'Connection Test',
                            CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 0,
                            'test', 'test', 'test', 'test'
                        ) ON CONFLICT (trace_id, span_id) DO NOTHING;
                    `;

          this.pgClient.query(testQuery, (err, result) => {
            if (err) {
              elizaLogger.error(`❌ Failed to insert test record: ${err}`);
            } else {
              elizaLogger.info(`✅ Test record inserted or verified.`);
            }
          });
        });
      });
    } catch (error) {
      elizaLogger.error(`❌ Failed to initialize PostgreSQL client: ${error}`);
      if (error instanceof Error && error.stack) {
        elizaLogger.error(`Stack trace: ${error.stack}`);
      }
      this.pgClient = null;
    }
  }

  onStart(span: ReadableSpan): void {
    elizaLogger.debug('🟢 Span started:', span.name);
  }

  onEnd(span: ReadableSpan): void {
    if (!this.pgClient || !this.isConnected || !this.isInitialized) {
      elizaLogger.warn(
        `⚠️ Cannot record span ${span.name} - PostgreSQL processor is not fully initialized (Connected: ${this.isConnected}, Initialized: ${this.isInitialized})`
      );
      return;
    }

    elizaLogger.debug(`🔄 Processing span: ${span.name}`);

    const spanContext = span.spanContext();

    const startTimeMs = span.startTime[0] * 1000 + span.startTime[1] / 1e6;
    const endTimeMs = span.endTime[0] * 1000 + span.endTime[1] / 1e6;
    const durationMs = Math.floor(endTimeMs - startTimeMs);

    const attributes = span.attributes || {};
    const resource = span.resource?.attributes || {};

    const safeTrim = (value: unknown): string | null => {
      if (typeof value !== 'string') return null;
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : null;
    };

    const spanData = {
      trace_id: spanContext.traceId,
      span_id: spanContext.spanId,
      parent_span_id: span.parentSpanId || null,
      trace_state: spanContext.traceState?.toString() || null,
      span_name: span.name,
      span_kind: span.kind,
      start_time: new Date(startTimeMs).toISOString(),
      end_time: new Date(endTimeMs).toISOString(),
      duration_ms: durationMs,
      status_code: span.status.code,
      status_message: span.status.message || null,
      attributes: attributes,
      events: span.events || [],
      links: span.links || [],
      resource: resource,
      agent_id:
        safeTrim(attributes['agent.id']) ||
        safeTrim(attributes.agentId) ||
        safeTrim(resource['service.instance.id']) ||
        'unknown',
      session_id:
        safeTrim(attributes['session.id']) ||
        safeTrim(attributes.sessionId) ||
        safeTrim(resource['session.id']) ||
        'unknown',
      environment:
        safeTrim(attributes.environment) ||
        safeTrim(resource['deployment.environment']) ||
        process.env.NODE_ENV ||
        'development',
      room_id: safeTrim(attributes['room.id']) || safeTrim(attributes.roomId) || 'unknown',
    };

    elizaLogger.debug(`🔄 Inserting span into PostgreSQL: ${span.name}`);
    this.insertTrace(spanData);
  }

  private async insertTrace(spanData: any): Promise<void> {
    if (!this.pgClient || !this.isConnected) return;

    elizaLogger.debug(`🔄 Begin insertTrace for span: ${spanData.span_name}`);

    const tableName = 'traces';

    const query = `
            INSERT INTO ${tableName} (
                trace_id,
                span_id,
                parent_span_id,
                trace_state,
                span_name,
                span_kind,
                start_time,
                end_time,
                duration_ms,
                status_code,
                status_message,
                attributes,
                events,
                links,
                resource,
                agent_id,
                session_id,
                environment,
                room_id
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
            ON CONFLICT (trace_id, span_id) DO NOTHING
            RETURNING id;
        `;

    const values = [
      spanData.trace_id,
      spanData.span_id,
      spanData.parent_span_id,
      spanData.trace_state,
      spanData.span_name,
      spanData.span_kind,
      spanData.start_time,
      spanData.end_time,
      spanData.duration_ms,
      spanData.status_code,
      spanData.status_message,
      JSON.stringify(spanData.attributes || {}),
      JSON.stringify(spanData.events || []),
      JSON.stringify(spanData.links || []),
      JSON.stringify(spanData.resource || {}),
      spanData.agent_id,
      spanData.session_id,
      spanData.environment,
      spanData.room_id,
    ];

    try {
      elizaLogger.debug(`Executing direct insert for span: ${spanData.span_name}`);
      elizaLogger.debug(`Span trace_id: ${spanData.trace_id}, span_id: ${spanData.span_id}`);

      const result = await this.pgClient.query(query, values);

      if (result.rows && result.rows.length > 0) {
        const id = result.rows[0].id;
        elizaLogger.info(`✅ Span inserted with ID ${id}: ${spanData.span_name}`);
      } else if (result.rowCount > 0) {
        elizaLogger.info(`✅ Span inserted (rowCount=${result.rowCount}): ${spanData.span_name}`);
      } else {
        elizaLogger.warn(`⚠️ No row inserted for span (likely conflict): ${spanData.span_name}`);
      }

      try {
        const verifyQuery = `SELECT id FROM ${tableName} WHERE trace_id = $1 AND span_id = $2`;
        const verifyResult = await this.pgClient.query(verifyQuery, [
          spanData.trace_id,
          spanData.span_id,
        ]);

        if (verifyResult.rows.length > 0) {
          elizaLogger.info(`✅ Verified span in database with ID ${verifyResult.rows[0].id}`);
        } else {
          elizaLogger.warn(`⚠️ Verification failed: Span not found in database after insert`);
        }
      } catch (verifyError) {
        elizaLogger.error(`❌ Error verifying span insertion: ${verifyError}`);
      }
    } catch (error) {
      elizaLogger.error(`❌ Error inserting span into PostgreSQL DB:`, error);

      if (error instanceof Error) {
        elizaLogger.error(`Error message: ${error.message}`);
        elizaLogger.error(`Error stack: ${error.stack}`);
      }

      elizaLogger.error(
        `Failed span data: ${JSON.stringify({
          span_name: spanData.span_name,
          trace_id: spanData.trace_id,
          span_id: spanData.span_id,
          agent_id: spanData.agent_id,
          session_id: spanData.session_id,
          room_id: spanData.room_id,
        })}`
      );
    }
  }

  shutdown(): Promise<void> {
    if (this.pgClient && this.isConnected) {
      this.pgClient.end();
      this.isConnected = false;
      elizaLogger.info('PostgreSQL database connection closed');
    }
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}

export class InstrumentationService extends Service implements IInstrumentationService {
  readonly name = 'INSTRUMENTATION';
  readonly capabilityDescription = 'Provides OpenTelemetry tracing and metrics capabilities.';
  public instrumentationConfig: InstrumentationConfig;
  private resource: Resource;
  private tracerProvider: NodeTracerProvider | null = null;
  private meterProvider: MeterProvider | null = null;
  private isShutdown = false;

  constructor(config?: InstrumentationConfig) {
    super();
    const isEnabled = config?.enabled || false;

    this.instrumentationConfig = {
      serviceName: config?.serviceName || process.env.OTEL_SERVICE_NAME || DEFAULT_SERVICE_NAME,
      enabled: isEnabled,
    };

    this.resource = new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: this.instrumentationConfig.serviceName,
    });

    if (this.isEnabled()) {
      this.initializeProviders();
      elizaLogger.info(
        `📊 Instrumentation Service configured as enabled for '${this.instrumentationConfig.serviceName}'.`
      );
    } else {
      elizaLogger.info('📊 Instrumentation Service configured as disabled.');
    }
  }

  private initializeProviders(): void {
    if (!this.isEnabled()) return;

    const postgresConnectionString = process.env.POSTGRES_URL_INSTRUMENTATION;
    let postgresSpanProcessorInstance: PostgresSpanProcessor | null = null;

    if (!postgresConnectionString) {
      elizaLogger.error(
        'Cannot initialize PostgreSQL Span Processor: POSTGRES_URL_INSTRUMENTATION is not set.'
      );
    } else {
      try {
        postgresSpanProcessorInstance = new PostgresSpanProcessor(postgresConnectionString);
        if (!postgresSpanProcessorInstance || !(postgresSpanProcessorInstance as any).pgClient) {
          elizaLogger.error(
            'Failed to initialize PostgreSQL span processor, or pgClient is missing.'
          );
          postgresSpanProcessorInstance = null; // Ensure it's null if initialization failed
        }
      } catch (e) {
        elizaLogger.error('Error creating PostgreSQL Span Processor instance:', e);
        postgresSpanProcessorInstance = null; // Ensure it's null on error
      }
    }

    this.tracerProvider = new NodeTracerProvider({
      resource: this.resource,
    });

    if (postgresSpanProcessorInstance) {
      this.tracerProvider.addSpanProcessor(postgresSpanProcessorInstance);
      elizaLogger.info('📊 PostgreSQL span processor added.');
    }

    this.tracerProvider.register();

    try {
      elizaLogger.info('Attempting to register PostgreSQL instrumentation...');
      registerInstrumentations({
        tracerProvider: this.tracerProvider,
        instrumentations: [
          new PgInstrumentation({
            enhancedDatabaseReporting: true,
          }),
        ],
      });
      elizaLogger.info('✅ Successfully registered OpenTelemetry instrumentations (pg).');
    } catch (e) {
      elizaLogger.error('❌ Failed to register instrumentations:', e);
    }

    this.meterProvider = new MeterProvider({ resource: this.resource });
    elizaLogger.warn('Metrics export is currently disabled.');

    metrics.setGlobalMeterProvider(this.meterProvider);
  }

  public isEnabled(): boolean {
    return !!this.instrumentationConfig.enabled && !this.isShutdown;
  }

  public getTracer(name?: string, version?: string): Tracer | null {
    if (!this.isEnabled() || !this.tracerProvider) {
      return trace.getTracer(name || this.instrumentationConfig.serviceName!, version);
    }
    return this.tracerProvider.getTracer(name || this.instrumentationConfig.serviceName!, version);
  }

  public getMeter(name?: string, version?: string): Meter | null {
    return metrics.getMeter(name || this.instrumentationConfig.serviceName!, version);
  }

  public async flush(): Promise<void> {
    if (!this.isEnabled() || this.isShutdown) {
      return;
    }
    elizaLogger.debug('📊 Flushing OpenTelemetry providers...');
    try {
      const results = await Promise.allSettled([
        this.tracerProvider?.forceFlush(),
        this.meterProvider?.forceFlush(),
      ]);
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          const provider = index === 0 ? 'Tracer' : 'Meter';
          elizaLogger.error(`Error flushing OpenTelemetry ${provider} provider:`, result.reason);
        }
      });
      elizaLogger.debug('📊 OpenTelemetry providers flush attempt complete.');
    } catch (error) {
      elizaLogger.error('Unexpected error during instrumentation flush: ', error);
    }
  }

  async stop(): Promise<void> {
    if (!this.isEnabled() || this.isShutdown) {
      return;
    }
    this.isShutdown = true;
    elizaLogger.info('📊 Shutting down Instrumentation Service...');
    try {
      const results = await Promise.allSettled([
        this.tracerProvider?.shutdown(),
        this.meterProvider?.shutdown(),
      ]);
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          const provider = index === 0 ? 'Tracer' : 'Meter';
          elizaLogger.error(
            `Error shutting down OpenTelemetry ${provider} provider:`,
            result.reason
          );
        }
      });
      elizaLogger.info('📊 Instrumentation Service shutdown attempt complete.');
    } catch (error) {
      elizaLogger.error('Unexpected error during instrumentation shutdown: ', error);
    }
  }

  static async start(
    runtime: IAgentRuntime,
    config?: InstrumentationConfig
  ): Promise<InstrumentationService> {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);

    const service = new InstrumentationService(config);
    return service;
  }
}
