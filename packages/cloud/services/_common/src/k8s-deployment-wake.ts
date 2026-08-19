/**
 * Issues a bounded Kubernetes Deployment scale request for gateway wake-up
 * paths while preserving an optional caller cancellation signal.
 */

export const DEFAULT_K8S_WAKE_TIMEOUT_MS = 15_000;

export interface K8sDeploymentWakeOptions {
  serverName: string;
  namespace: string;
  token: string;
  caCert: string | null;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  createTimeoutSignal?: (timeoutMs: number) => AbortSignal;
}

export async function patchK8sDeploymentScale(
  options: K8sDeploymentWakeOptions,
): Promise<Response> {
  const fetchFn = options.fetchFn ?? fetch;
  const createTimeoutSignal =
    options.createTimeoutSignal ?? AbortSignal.timeout.bind(AbortSignal);
  const timeoutSignal = createTimeoutSignal(
    options.timeoutMs ?? DEFAULT_K8S_WAKE_TIMEOUT_MS,
  );
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;
  const apiUrl = `https://kubernetes.default.svc/apis/apps/v1/namespaces/${options.namespace}/deployments/${options.serverName}/scale`;

  return fetchFn(apiUrl, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${options.token}`,
      "Content-Type": "application/strategic-merge-patch+json",
    },
    body: JSON.stringify({ spec: { replicas: 1 } }),
    signal,
    tls: { ca: options.caCert ?? undefined },
  } as RequestInit);
}
