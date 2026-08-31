/**
 * Projects live-stack subprocess diagnostics into a closed event schema.
 * Child bytes are deliberately not accepted by this boundary.
 */
import { appendFileSync } from "node:fs";
import type { Readable } from "node:stream";

export type LiveStackDiagnosticChannel = "stdout" | "stderr";

export type LiveStackDiagnosticComponent =
  | "live-runtime"
  | "optional-plugin-build"
  | "real-local-runtime"
  | "renderer-build"
  | "stub-runtime";

type LiveStackDiagnosticEvent =
  | {
      category: "capture-started";
      component: LiveStackDiagnosticComponent;
    }
  | {
      category: "child-output-observed";
      channel: LiveStackDiagnosticChannel;
      component: LiveStackDiagnosticComponent;
    }
  | {
      category: "process-failed";
      component: LiveStackDiagnosticComponent;
      exitCode: number;
    }
  | {
      category: "process-timed-out";
      component: LiveStackDiagnosticComponent;
    };

type LiveStackStartupFailureClass =
  | "aggregate-error"
  | "error"
  | "non-error"
  | "range-error"
  | "reference-error"
  | "syntax-error"
  | "type-error";

const LIVE_STACK_DIAGNOSTIC_COMPONENTS = new Set<LiveStackDiagnosticComponent>([
  "live-runtime",
  "optional-plugin-build",
  "real-local-runtime",
  "renderer-build",
  "stub-runtime",
]);

function requireSafeComponent(
  component: LiveStackDiagnosticComponent,
): LiveStackDiagnosticComponent {
  if (!LIVE_STACK_DIAGNOSTIC_COMPONENTS.has(component)) {
    throw new Error("Unsupported live-stack diagnostic component.");
  }
  return component;
}

export function formatSafeLiveStackDiagnostic(
  event: LiveStackDiagnosticEvent,
): string {
  const base = {
    schema: "elizaos.live-stack-diagnostic/v1",
    component: requireSafeComponent(event.component),
  } as const;
  switch (event.category) {
    case "capture-started":
      return JSON.stringify({
        ...base,
        category: "capture-started",
      });
    case "child-output-observed":
      if (event.channel !== "stdout" && event.channel !== "stderr") {
        throw new Error("Unsupported live-stack diagnostic channel.");
      }
      return JSON.stringify({
        ...base,
        category: "child-output-observed",
        channel: event.channel,
      });
    case "process-failed":
      return JSON.stringify({
        ...base,
        category: "process-failed",
        exitCode:
          Number.isInteger(event.exitCode) &&
          event.exitCode >= 0 &&
          event.exitCode <= 255
            ? event.exitCode
            : 1,
      });
    case "process-timed-out":
      return JSON.stringify({
        ...base,
        category: "process-timed-out",
      });
    default:
      throw new Error("Unsupported live-stack diagnostic category.");
  }
}

function classifyStartupFailure(error: unknown): LiveStackStartupFailureClass {
  try {
    if (error instanceof AggregateError) return "aggregate-error";
    if (error instanceof TypeError) return "type-error";
    if (error instanceof ReferenceError) return "reference-error";
    if (error instanceof SyntaxError) return "syntax-error";
    if (error instanceof RangeError) return "range-error";
    if (error instanceof Error) return "error";
  } catch {
    // A hostile Proxy can throw from [[GetPrototypeOf]] during instanceof.
    return "non-error";
  }
  return "non-error";
}

/** Projects an arbitrary startup failure without reading its properties. */
export function formatSafeLiveStackStartupFailure(
  component: LiveStackDiagnosticComponent,
  error: unknown,
): string {
  return JSON.stringify({
    schema: "elizaos.live-stack-diagnostic/v1",
    category: "startup-failed",
    component: requireSafeComponent(component),
    failureClass: classifyStartupFailure(error),
  });
}

export function createSafeChildOutputObserver(args: {
  artifactPath?: string | null;
  component: LiveStackDiagnosticComponent;
  writeConsole?: (line: string) => void;
}): {
  observe: (channel: LiveStackDiagnosticChannel) => void;
} {
  const observedChannels = new Set<LiveStackDiagnosticChannel>();
  const writeConsole =
    args.writeConsole ?? ((line: string) => process.stdout.write(`${line}\n`));
  const writeDiagnostic = (line: string): void => {
    writeConsole(line);
    if (args.artifactPath) {
      appendFileSync(args.artifactPath, `${line}\n`, "utf8");
    }
  };
  writeDiagnostic(
    formatSafeLiveStackDiagnostic({
      category: "capture-started",
      component: args.component,
    }),
  );

  return {
    observe(channel): void {
      if (channel !== "stdout" && channel !== "stderr") return;
      if (observedChannels.has(channel)) return;
      observedChannels.add(channel);

      const line = formatSafeLiveStackDiagnostic({
        category: "child-output-observed",
        component: args.component,
        channel,
      });
      writeDiagnostic(line);
    },
  };
}

/**
 * Attaches the closed diagnostic projection directly to child streams.
 *
 * The data callbacks deliberately accept no chunk argument, so untrusted child
 * bytes never cross this boundary or become available to a console/artifact
 * writer. Keeping this adapter beside the projector also makes the real stream
 * wiring behavior testable without booting the credentialed live harness.
 */
export function attachSafeChildOutputObserver(args: {
  artifactPath?: string | null;
  child: {
    stderr: Readable;
    stdout: Readable;
  };
  component: LiveStackDiagnosticComponent;
  writeConsole?: (line: string) => void;
}): void {
  const observer = createSafeChildOutputObserver({
    artifactPath: args.artifactPath,
    component: args.component,
    writeConsole: args.writeConsole,
  });
  args.child.stdout.on("data", () => observer.observe("stdout"));
  args.child.stderr.on("data", () => observer.observe("stderr"));
}
