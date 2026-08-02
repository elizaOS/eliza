/** Audit sink contract and the optional structured-logger implementation. */

import { logger } from "@/lib/utils/logger";
import type { AuditEvent } from "./types.js";

export interface AuditSink {
  readonly name: string;
  /** Required sinks make dispatch fail observably when delivery fails. */
  readonly required?: boolean;
  emit(event: AuditEvent): Promise<void>;
}

export class LoggerSink implements AuditSink {
  readonly name = "logger";
  readonly required = false;
  async emit(event: AuditEvent): Promise<void> {
    logger.info("[AuditSink] event emitted", {
      audit: event,
    });
  }
}
