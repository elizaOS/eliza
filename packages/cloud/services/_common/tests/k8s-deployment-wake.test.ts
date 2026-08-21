/** Exercises the shared Kubernetes wake PATCH against deterministic transport boundaries. */

import { describe, expect, mock, test } from "bun:test";
import {
  DEFAULT_K8S_WAKE_TIMEOUT_MS,
  patchK8sDeploymentScale,
} from "../src/k8s-deployment-wake";

const baseOptions = {
  serverName: "agent-server-1",
  namespace: "agents",
  token: "test-token",
  caCert: "test-ca",
};

describe("patchK8sDeploymentScale", () => {
  test("sends the scale payload with the shared deadline", async () => {
    const timeoutSignal = new AbortController().signal;
    const createTimeoutSignal = mock(() => timeoutSignal);
    const fetchFn = mock(async () => new Response(null, { status: 200 }));

    const response = await patchK8sDeploymentScale({
      ...baseOptions,
      fetchFn: fetchFn as typeof fetch,
      createTimeoutSignal,
    });

    expect(response.status).toBe(200);
    expect(createTimeoutSignal).toHaveBeenCalledWith(
      DEFAULT_K8S_WAKE_TIMEOUT_MS,
    );
    expect(fetchFn).toHaveBeenCalledWith(
      "https://kubernetes.default.svc/apis/apps/v1/namespaces/agents/deployments/agent-server-1/scale",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ spec: { replicas: 1 } }),
        signal: timeoutSignal,
      }),
    );
  });

  test("aborts a never-settling PATCH at the injected deadline", async () => {
    const fetchFn = mock(
      async (_input: string | URL | Request, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    );

    await expect(
      patchK8sDeploymentScale({
        ...baseOptions,
        timeoutMs: 5,
        fetchFn: fetchFn as typeof fetch,
      }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  test("composes explicit caller cancellation with the deadline", async () => {
    const caller = new AbortController();
    const fetchFn = mock(
      async (_input: string | URL | Request, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    );
    const pending = patchK8sDeploymentScale({
      ...baseOptions,
      signal: caller.signal,
      timeoutMs: 60_000,
      fetchFn: fetchFn as typeof fetch,
    });

    caller.abort(new DOMException("caller cancelled", "AbortError"));

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  test("returns non-2xx responses for the owning service to classify", async () => {
    const response = await patchK8sDeploymentScale({
      ...baseOptions,
      fetchFn: mock(
        async () => new Response("denied", { status: 403 }),
      ) as typeof fetch,
    });

    expect(response.status).toBe(403);
    expect(await response.text()).toBe("denied");
  });
});
