import type {
  RuntimeManagementRequest,
  RuntimeManagementResult,
} from "@elizaos/contracts";

/** Secret-bearing fields remain inside the host and never cross agent HTTP/WS. */
export interface LocalRuntimeManagementRequest
  extends RuntimeManagementRequest {
  accessToken?: string;
}
type RuntimeManagementExecutor = (
  request: LocalRuntimeManagementRequest,
) => Promise<RuntimeManagementResult>;
let executor: RuntimeManagementExecutor | null = null;

/** Install the application host's executor before rendering runtime controls. */
export function configureRuntimeManagement(
  next: RuntimeManagementExecutor,
): () => void {
  const previous = executor;
  executor = next;
  return () => {
    if (executor === next) executor = previous;
  };
}
export async function executeRuntimeManagementCommand(
  request: LocalRuntimeManagementRequest,
): Promise<RuntimeManagementResult> {
  if (executor) return executor(request);
  return {
    ok: false,
    op: request.op,
    error: "Runtime management is unavailable in this host.",
  };
}
