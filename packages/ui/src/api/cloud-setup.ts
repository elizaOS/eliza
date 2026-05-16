import {
  type CloudSetupSessionService,
  type ContainerHandoffEnvelope,
  MockCloudSetupSessionService,
  type SetupExtractedFact,
  type SetupSessionEnvelope,
  type SetupTranscriptMessage,
} from "@elizaos/cloud-sdk/cloud-setup-session";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type CloudSetupStatus =
  | "idle"
  | "starting"
  | "ready"
  | "provisioning"
  | "handoff"
  | "error";

export interface UseCloudSetupSessionOptions {
  tenantId?: string;
  service?: CloudSetupSessionService;
  /** Poll cadence in ms while the container is provisioning. Defaults to 5000. */
  pollIntervalMs?: number;
  /** Auto-start a session on mount. Defaults to true. */
  autoStart?: boolean;
  /** Called exactly once when the handoff envelope is ready. */
  onHandoff?: (envelope: ContainerHandoffEnvelope) => void;
}

export interface UseCloudSetupSessionResult {
  envelope: SetupSessionEnvelope | null;
  transcript: SetupTranscriptMessage[];
  facts: SetupExtractedFact[];
  status: CloudSetupStatus;
  error: Error | null;
  sendMessage(text: string): Promise<void>;
  cancel(): Promise<void>;
}

const DEFAULT_TENANT_ID = "local-dev-tenant";
const DEFAULT_POLL_INTERVAL_MS = 5000;

export function useCloudSetupSession(
  opts: UseCloudSetupSessionOptions = {},
): UseCloudSetupSessionResult {
  const tenantId = opts.tenantId ?? DEFAULT_TENANT_ID;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const autoStart = opts.autoStart ?? true;

  const service = useMemo<CloudSetupSessionService>(
    () => opts.service ?? new MockCloudSetupSessionService(),
    [opts.service],
  );
  const onHandoffRef = useRef(opts.onHandoff);
  onHandoffRef.current = opts.onHandoff;

  const [envelope, setEnvelope] = useState<SetupSessionEnvelope | null>(null);
  const [transcript, setTranscript] = useState<SetupTranscriptMessage[]>([]);
  const [facts, setFacts] = useState<SetupExtractedFact[]>([]);
  const [status, setStatus] = useState<CloudSetupStatus>("idle");
  const [error, setError] = useState<Error | null>(null);

  const handoffCompletedRef = useRef(false);
  const sessionRef = useRef<SetupSessionEnvelope | null>(null);
  sessionRef.current = envelope;

  const captureError = useCallback((err: unknown) => {
    const next = err instanceof Error ? err : new Error(String(err));
    setError(next);
    setStatus("error");
  }, []);

  useEffect(() => {
    if (!autoStart) {
      return;
    }
    let cancelled = false;
    setStatus("starting");
    service
      .startSession({ tenantId })
      .then((started) => {
        if (cancelled) {
          return;
        }
        setEnvelope(started);
        setStatus(
          started.containerStatus === "ready" ? "ready" : "provisioning",
        );
      })
      .catch((err) => {
        if (!cancelled) {
          captureError(err);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [autoStart, captureError, service, tenantId]);

  useEffect(() => {
    if (!envelope || envelope.containerStatus !== "provisioning") {
      return;
    }
    let cancelled = false;
    const tick = (): Promise<void> =>
      service
        .getStatus(envelope.sessionId)
        .then((next) => {
          if (cancelled) {
            return;
          }
          setEnvelope(next);
          if (next.containerStatus === "ready") {
            setStatus("ready");
          } else if (next.containerStatus === "failed") {
            captureError(new Error("container provisioning failed"));
          }
        })
        .catch((err) => {
          if (!cancelled) {
            captureError(err);
          }
        });
    const handle = setInterval(tick, pollIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [captureError, envelope, pollIntervalMs, service]);

  useEffect(() => {
    if (
      !envelope ||
      envelope.containerStatus !== "ready" ||
      !envelope.containerId ||
      handoffCompletedRef.current
    ) {
      return;
    }
    handoffCompletedRef.current = true;
    setStatus("handoff");
    service
      .finalizeHandoff({
        sessionId: envelope.sessionId,
        containerId: envelope.containerId,
      })
      .then((result) => {
        onHandoffRef.current?.(result);
      })
      .catch((err) => {
        handoffCompletedRef.current = false;
        captureError(err);
      });
  }, [captureError, envelope, service]);

  const sendMessage = useCallback(
    async (text: string): Promise<void> => {
      const current = sessionRef.current;
      if (!current) {
        throw new Error("no active setup session");
      }
      const trimmed = text.trim();
      if (!trimmed) {
        return;
      }
      const userMessage: SetupTranscriptMessage = {
        id: `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        role: "user",
        content: trimmed,
        createdAt: Date.now(),
      };
      setTranscript((prev) => [...prev, userMessage]);
      try {
        const result = await service.sendMessage({
          sessionId: current.sessionId,
          message: trimmed,
        });
        setTranscript((prev) => [...prev, ...result.replies]);
        if (result.facts.length > 0) {
          setFacts((prev) => [...prev, ...result.facts]);
        }
      } catch (err) {
        captureError(err);
      }
    },
    [captureError, service],
  );

  const cancel = useCallback(async (): Promise<void> => {
    const current = sessionRef.current;
    if (!current) {
      return;
    }
    try {
      await service.cancel(current.sessionId);
    } catch (err) {
      captureError(err);
      return;
    }
    setStatus("idle");
    setEnvelope(null);
    setTranscript([]);
    setFacts([]);
    handoffCompletedRef.current = false;
  }, [captureError, service]);

  return { envelope, transcript, facts, status, error, sendMessage, cancel };
}
