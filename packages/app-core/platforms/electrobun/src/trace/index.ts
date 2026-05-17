import { DynamicViewRegistry } from "../dynamic-views/registry";
import { DynamicViewSessionManager } from "../dynamic-views/session-manager";
import { createTraceHost, type TraceHost } from "./trace-host-requests";
import { TraceService } from "./trace-service";
import { createTraceDynamicViewManifest } from "./trace-dynamic-view";
import { TraceStore } from "./trace-store";

let traceService: TraceService | null = null;

export function getTraceService(options: {
  dynamicViewRegistry: DynamicViewRegistry;
  dynamicViewSessions: DynamicViewSessionManager;
}): TraceService {
  if (!traceService) {
    traceService = new TraceService({
      store: new TraceStore(),
      dynamicViewRegistry: options.dynamicViewRegistry,
      dynamicViewSessions: options.dynamicViewSessions,
    });
  }
  options.dynamicViewRegistry.register(createTraceDynamicViewManifest(), {
    update: true,
  });
  return traceService;
}

export function createTraceHostForRuntime(service: TraceService): TraceHost {
  return createTraceHost(service);
}

export function resetTraceStateForTests(): void {
  traceService = null;
}

export * from "./types";
export * from "./errors";
export * from "./trace-store";
export * from "./trace-service";
export * from "./trace-dynamic-view";
export * from "./trace-host-requests";
