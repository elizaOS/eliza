import { Tracer, Meter, diag, DiagConsoleLogger, DiagLogLevel, metrics, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
// import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http"; // Removed import
import { Resource } from "@opentelemetry/resources";
import { SemanticResourceAttributes } from "@opentelemetry/semantic-conventions";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { IInstrumentationService, InstrumentationConfig } from "./types";
import { elizaLogger } from "../logger"; // Assuming logger is in ../logger
import { Service, ServiceType, IAgentRuntime } from "../types"; // Assuming Service definition location

const DEFAULT_SERVICE_NAME = "eliza-agent";

// Enable OpenTelemetry diagnostics
diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);

export class InstrumentationService extends Service implements IInstrumentationService {
    readonly name = "INSTRUMENTATION"; // Or ServiceType.INSTRUMENTATION if defined
    readonly capabilityDescription = "Provides OpenTelemetry tracing and metrics capabilities.";
    public instrumentationConfig: InstrumentationConfig; // Renamed to avoid conflict with base Service class
    private resource: Resource;
    private tracerProvider: NodeTracerProvider | null = null;
    private meterProvider: MeterProvider | null = null;
    private isShutdown = false;

    constructor(config?: InstrumentationConfig) {
        super(); // Pass runtime if needed by base Service constructor
        this.instrumentationConfig = {
            serviceName: config?.serviceName || process.env.OTEL_SERVICE_NAME || DEFAULT_SERVICE_NAME,
            otlpEndpoint: config?.otlpEndpoint || process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
            enabled: config?.enabled ?? (process.env.OTEL_INSTRUMENTATION_ENABLED === 'true' || !!process.env.OTEL_EXPORTER_OTLP_ENDPOINT)
        };

        this.resource = new Resource({
            [SemanticResourceAttributes.SERVICE_NAME]: this.instrumentationConfig.serviceName,
            // Add other relevant resource attributes (e.g., version, instance ID)
        });

        if (this.isEnabled()) {
            this.initializeProviders();
            elizaLogger.info(`📊 Instrumentation Service enabled for '${this.instrumentationConfig.serviceName}'. Endpoint: ${this.instrumentationConfig.otlpEndpoint || 'Console/None'}`);
        } else {
            elizaLogger.info("📊 Instrumentation Service disabled.");
        }
    }

    private initializeProviders(): void {
        if (!this.isEnabled()) return;

        // --- Tracer Provider Setup ---
        this.tracerProvider = new NodeTracerProvider({ resource: this.resource });

        // Add Span Processors (e.g., Batch + OTLP/Console)
        if (this.instrumentationConfig.otlpEndpoint) {
            try {
                // Ensure no trailing slash in the URL
                const cleanUrl = this.instrumentationConfig.otlpEndpoint.replace(/\/$/, '');
                const exporter = new OTLPTraceExporter();
                this.tracerProvider.addSpanProcessor(new BatchSpanProcessor(exporter));
            } catch (e) {
                elizaLogger.error("Failed to initialize OTLP Trace Exporter:", e)
                this.instrumentationConfig.enabled = false; // Disable if exporter fails
                return; // Stop further initialization
            }
        } else {
            // Potentially add a ConsoleSpanExporter for local dev if no endpoint is set
            elizaLogger.warn("OTLP endpoint not configured for traces. Spans will not be exported.");
            // const { ConsoleSpanExporter } = await import("@opentelemetry/sdk-trace-node");
            // this.tracerProvider.addSpanProcessor(new SimpleSpanProcessor(new ConsoleSpanExporter()));
        }

        this.tracerProvider.register();

        // --- Meter Provider Setup (Metrics Export Disabled for now) ---
        this.meterProvider = new MeterProvider({ resource: this.resource });
        elizaLogger.warn("Metrics export is currently disabled pending dependency check.");
        // TODO: Re-enable metrics export when dependency is confirmed
        /*
        let metricReader;
        if (this.instrumentationConfig.otlpEndpoint) {
           try {
             // Assume OTLPMetricExporter exists and is imported if dependency added back
             metricReader = new PeriodicExportingMetricReader({
               exporter: new OTLPMetricExporter({ url: this.instrumentationConfig.otlpEndpoint }),
               exportIntervalMillis: 10000,
             });
           } catch(e) {
             elizaLogger.error("Failed to initialize OTLP Metric Exporter:", e)
           }
        } else {
          elizaLogger.warn("OTLP endpoint not configured for metrics. Metrics will not be exported.");
        }

        if (metricReader) {
          this.meterProvider.addMetricReader(metricReader);
        }
        */
        metrics.setGlobalMeterProvider(this.meterProvider); // Register MeterProvider even if no exporter
    }

    public isEnabled(): boolean {
        return !!this.instrumentationConfig.enabled && !this.isShutdown;
    }

    public getTracer(name?: string, version?: string): Tracer | null {
        if (!this.isEnabled() || !this.tracerProvider) {
            // Return a NoOpTracer if disabled
            return trace.getTracer(name || this.instrumentationConfig.serviceName!, version);
        }
        return this.tracerProvider.getTracer(name || this.instrumentationConfig.serviceName!, version);
    }

    public getMeter(name?: string, version?: string): Meter | null {
        // Always return a meter (could be NoOp if disabled)
        return metrics.getMeter(name || this.instrumentationConfig.serviceName!, version);
    }

    public async flush(): Promise<void> {
        if (!this.isEnabled() || this.isShutdown) {
            return;
        }
        elizaLogger.debug("📊 Flushing OpenTelemetry providers...");
        try {
            // Use Promise.allSettled to ensure both attempt flush even if one fails
            const results = await Promise.allSettled([
                this.tracerProvider?.forceFlush(),
                this.meterProvider?.forceFlush(), // Added Meter flush for consistency
            ]);
            results.forEach((result, index) => {
                if (result.status === 'rejected') {
                    const provider = index === 0 ? 'Tracer' : 'Meter';
                    elizaLogger.error(`Error flushing OpenTelemetry ${provider} provider:`, result.reason);
                }
            });
            elizaLogger.debug("📊 OpenTelemetry providers flush attempt complete.");
        } catch (error) {
            elizaLogger.error("Unexpected error during instrumentation flush: ", error);
        }
    }

    async stop(): Promise<void> {
        if (!this.isEnabled() || this.isShutdown) {
            return;
        }
        this.isShutdown = true;
        elizaLogger.info("📊 Shutting down Instrumentation Service...");
        try {
            // Use Promise.allSettled to ensure both attempt shutdown even if one fails
            const results = await Promise.allSettled([
                this.tracerProvider?.shutdown(),
                this.meterProvider?.shutdown(),
            ]);
            results.forEach((result, index) => {
                if (result.status === 'rejected') {
                    const provider = index === 0 ? 'Tracer' : 'Meter';
                    elizaLogger.error(`Error shutting down OpenTelemetry ${provider} provider:`, result.reason);
                }
            });
            elizaLogger.info("📊 Instrumentation Service shutdown attempt complete.");
        } catch (error) {
            // Catch any unexpected errors during shutdown orchestration
            elizaLogger.error("Unexpected error during instrumentation shutdown: ", error);
        }
    }

    // Implement the static start method required by Service base class (if applicable)
    // This assumes the Service base class or the runtime handles registration
    static async start(runtime: IAgentRuntime, config?: InstrumentationConfig): Promise<InstrumentationService> {
        const service = new InstrumentationService(config);
        // If runtime needs explicit registration:
        // runtime.registerServiceInstance(service); // Hypothetical method
        return service;
    }
} 