/**
 * Workflow Events System
 *
 * Enables TypeScript workflows to emit real-time events that are:
 * 1. Sent via Windows named pipe to the MCP agent
 * 2. Forwarded as MCP notifications to connected clients
 * 3. Included in the final workflow result for post-execution analysis
 *
 * @example
 * ```typescript
 * import { createStep, emit } from '@mediar-ai/workflow';
 *
 * createStep({
 *   id: 'login',
 *   name: 'Login',
 *   execute: async ({ desktop }) => {
 *     emit.progress(1, 3, 'Starting login...');
 *     await desktop.locator('role:textbox').fill('user@example.com');
 *
 *     emit.progress(2, 3, 'Entering credentials...');
 *     await desktop.locator('role:button[name="Submit"]').click();
 *
 *     emit.progress(3, 3, 'Login complete');
 *     emit.screenshot('/tmp/login-success.png', 'Login confirmation');
 *   }
 * });
 * ```
 */

import * as fs from 'fs';
import * as net from 'net';

/**
 * Base event structure - all events extend this
 */
interface BaseEvent {
    __mcp_event__: true;
    type: string;
    timestamp: string;
}

/**
 * Progress event - maps to MCP notifications/progress
 */
export interface ProgressEvent extends BaseEvent {
    type: 'progress';
    current: number;
    total?: number;
    message?: string;
}

/**
 * Step lifecycle events
 */
export interface StepEvent extends BaseEvent {
    type: 'step_started' | 'step_completed' | 'step_failed';
    stepId: string;
    stepName: string;
    stepIndex?: number;
    totalSteps?: number;
    duration?: number;
    error?: string;
}

/**
 * Screenshot event - for visual debugging
 */
export interface ScreenshotEvent extends BaseEvent {
    type: 'screenshot';
    path?: string;
    base64?: string;
    annotation?: string;
    element?: string;
}

/**
 * Custom data event - for arbitrary workflow data
 */
export interface DataEvent extends BaseEvent {
    type: 'data';
    key: string;
    value: any;
}

/**
 * Log event - structured logging with levels
 */
export interface LogEvent extends BaseEvent {
    type: 'log';
    level: 'debug' | 'info' | 'warn' | 'error';
    message: string;
    data?: any;
}

/**
 * Union of all event types
 */
export type WorkflowEvent =
    | ProgressEvent
    | StepEvent
    | ScreenshotEvent
    | DataEvent
    | LogEvent;

/**
 * Event payload without the automatically added fields
 */
type EventPayload = {
    type: string;
    [key: string]: any;
};

/**
 * Event transport - handles sending events to the MCP agent
 */
class EventTransport {
    private pipeStream: fs.WriteStream | null = null;
    private pipePath: string | null = null;
    private connectionAttempted = false;
    private useStderr = false;

    constructor() {
        // Get pipe path from environment
        this.pipePath = process.env.MCP_EVENT_PIPE || null;

        // If no pipe path, fall back to stderr (for backward compatibility)
        if (!this.pipePath) {
            this.useStderr = true;
        }
    }

    /**
     * Connect to the named pipe (lazy connection on first write)
     */
    private connect(): boolean {
        if (this.useStderr) {
            return true;
        }

        if (this.pipeStream) {
            return true;
        }

        if (this.connectionAttempted) {
            return false;
        }

        this.connectionAttempted = true;

        try {
            // Open the named pipe for writing
            this.pipeStream = fs.createWriteStream(this.pipePath!, { flags: 'w' });

            this.pipeStream.on('error', (err) => {
                console.error(`[workflow-events] Pipe error: ${err.message}`);
                this.pipeStream = null;
                this.useStderr = true;
            });

            return true;
        } catch (err: any) {
            console.error(`[workflow-events] Failed to connect to pipe: ${err.message}`);
            this.useStderr = true;
            return false;
        }
    }

    /**
     * Send an event
     */
    send(event: EventPayload): void {
        const fullEvent = {
            __mcp_event__: true as const,
            timestamp: new Date().toISOString(),
            ...event,
        };

        const json = JSON.stringify(fullEvent) + '\n';

        if (this.useStderr || !this.connect()) {
            // Fall back to stderr
            process.stderr.write(json);
            return;
        }

        try {
            this.pipeStream!.write(json);
        } catch (err: any) {
            // Fall back to stderr on write error
            process.stderr.write(json);
        }
    }

    /**
     * Close the transport
     */
    close(): void {
        if (this.pipeStream) {
            this.pipeStream.end();
            this.pipeStream = null;
        }
    }
}

// Global transport instance
const transport = new EventTransport();

// Cleanup on process exit
process.on('exit', () => transport.close());
process.on('SIGINT', () => { transport.close(); process.exit(0); });
process.on('SIGTERM', () => { transport.close(); process.exit(0); });

/**
 * Event emitter with typed methods for great DX
 *
 * @example
 * ```typescript
 * import { emit } from '@mediar-ai/workflow';
 *
 * // Progress updates (shown in MCP client progress bar)
 * emit.progress(1, 5, 'Starting...');
 * emit.progress(2, 5, 'Processing items...');
 *
 * // Structured logging
 * emit.log('info', 'Found 10 items to process');
 * emit.log('debug', 'Item details', { items: [...] });
 *
 * // Screenshots for debugging
 * emit.screenshot('/tmp/before.png', 'State before action');
 *
 * // Custom data
 * emit.data('orderTotal', 125.50);
 * emit.data('extractedEmails', ['a@b.com', 'c@d.com']);
 * ```
 */
export const emit = {
    /**
     * Emit a progress update
     * @param current - Current progress value (e.g., step number)
     * @param total - Total steps (optional, omit for indeterminate progress)
     * @param message - Human-readable progress message
     */
    progress(current: number, total?: number, message?: string): void {
        transport.send({ type: 'progress', current, total, message });
    },

    /**
     * Emit a step started event (usually called automatically by the runner)
     */
    stepStarted(stepId: string, stepName: string, stepIndex?: number, totalSteps?: number): void {
        transport.send({ type: 'step_started', stepId, stepName, stepIndex, totalSteps });
    },

    /**
     * Emit a step completed event (usually called automatically by the runner)
     */
    stepCompleted(stepId: string, stepName: string, duration: number, stepIndex?: number, totalSteps?: number): void {
        transport.send({ type: 'step_completed', stepId, stepName, duration, stepIndex, totalSteps });
    },

    /**
     * Emit a step failed event (usually called automatically by the runner)
     */
    stepFailed(stepId: string, stepName: string, error: string, duration: number): void {
        transport.send({ type: 'step_failed', stepId, stepName, error, duration });
    },

    /**
     * Emit a screenshot event for visual debugging
     * @param data - File path, base64 string, or ScreenshotResult from capture()
     * @param annotation - Description of what the screenshot shows
     * @param element - Optional element selector that was captured
     */
    screenshot(data: string | { imageData: number[]; width: number; height: number }, annotation?: string, element?: string): void {
        let base64Data: string | undefined;
        let pathData: string | undefined;
        
        if (typeof data === 'object' && 'imageData' in data) {
            // ScreenshotResult object - convert imageData to base64
            const bytes = new Uint8Array(data.imageData);
            let binary = '';
            for (let i = 0; i < bytes.length; i++) {
                binary += String.fromCharCode(bytes[i]);
            }
            base64Data = btoa(binary);
        } else if (typeof data === 'string') {
            const isBase64 = data.startsWith('data:') || data.length > 500;
            if (isBase64) {
                base64Data = data;
            } else {
                pathData = data;
            }
        }
        
        transport.send({
            type: 'screenshot',
            ...(base64Data ? { base64: base64Data } : { path: pathData }),
            annotation,
            element,
        });
    },

    /**
     * Emit custom data for post-processing or display
     * @param key - Data identifier
     * @param value - Any JSON-serializable value
     */
    data(key: string, value: any): void {
        transport.send({ type: 'data', key, value });
    },

    /**
     * Emit a structured log message
     * @param level - Log severity level
     * @param message - Log message
     * @param data - Optional additional data
     */
    /**
     * Show status text on the workflow overlay
     * @param text - Status message to display
     * @param durationMs - How long to show (default 3000ms)
     */
    status(text: string, durationMs?: number): void {
        transport.send({ type: 'status', message: text, duration: durationMs });
    },

    log(level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: any): void {
        transport.send({ type: 'log', level, message, data });
    },

    /**
     * Emit a raw event (for advanced use cases)
     */
    raw(event: Omit<WorkflowEvent, '__mcp_event__' | 'timestamp'>): void {
        transport.send(event);
    },
};

/**
 * Create a scoped emitter for a specific step
 * Automatically includes step context in all events
 *
 * @example
 * ```typescript
 * createStep({
 *   id: 'process_items',
 *   name: 'Process Items',
 *   execute: async ({ desktop }) => {
 *     const stepEmit = createStepEmitter('process_items', 'Process Items', 2, 5);
 *
 *     stepEmit.progress(0, 10, 'Starting...');
 *     for (let i = 0; i < 10; i++) {
 *       await processItem(i);
 *       stepEmit.progress(i + 1, 10, `Processed item ${i + 1}`);
 *     }
 *   }
 * });
 * ```
 */
export function createStepEmitter(stepId: string, stepName: string, stepIndex?: number, totalSteps?: number) {
    return {
        progress(current: number, total?: number, message?: string): void {
            emit.progress(current, total, message ? `[${stepName}] ${message}` : `[${stepName}] Step ${current}/${total || '?'}`);
        },

        log(level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: any): void {
            emit.log(level, `[${stepName}] ${message}`, data);
        },
        screenshot(data: string | { imageData: number[]; width: number; height: number }, annotation?: string, element?: string): void {
            emit.screenshot(data, annotation ? `[${stepName}] ${annotation}` : `[${stepName}] Screenshot`, element);
        },
        data(key: string, value: any): void {
            emit.data(`${stepId}.${key}`, value);
        },
        started(): void {
            emit.stepStarted(stepId, stepName, stepIndex, totalSteps);
        },
        completed(duration: number): void {
            emit.stepCompleted(stepId, stepName, duration, stepIndex, totalSteps);
        },
        status(text: string, durationMs?: number): void {
            emit.status(`[${stepName}] ${text}`, durationMs);
        },
        failed(error: string, duration: number): void {
            emit.stepFailed(stepId, stepName, error, duration);
        },
    };
}

export type StepEmitter = ReturnType<typeof createStepEmitter>;

/**
 * For testing: get the current transport mode
 * @internal
 */
export function _getTransportMode(): 'pipe' | 'stderr' {
    return process.env.MCP_EVENT_PIPE ? 'pipe' : 'stderr';
}
