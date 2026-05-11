import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CreateJobRequest,
  InferenceEndpoint,
  InferenceStats,
  TrainingBudget,
  TrainingJob,
  TrainingJobDetail,
  TrainingModel,
} from "../types";

interface ApiState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

async function apiCall<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  return response.json();
}

export function useTrainingJobs(pollIntervalMs: number = 10000) {
  const [state, setState] = useState<ApiState<TrainingJob[]>>({
    data: null,
    loading: true,
    error: null,
  });
  const mountedRef = useRef(true);
  const pollTimerRef = useRef<NodeJS.Timeout | undefined>(undefined);

  const fetchJobs = useCallback(async () => {
    try {
      const data = await apiCall<{ jobs: TrainingJob[] }>("/api/training/jobs");
      if (!mountedRef.current) return;
      setState({ data: data.jobs, loading: false, error: null });
    } catch (err) {
      if (!mountedRef.current) return;
      setState({
        data: null,
        loading: false,
        error: err instanceof Error ? err.message : "Failed to fetch jobs",
      });
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    fetchJobs();
    pollTimerRef.current = setInterval(fetchJobs, pollIntervalMs);
    return () => {
      mountedRef.current = false;
      if (pollTimerRef.current !== undefined) {
        clearInterval(pollTimerRef.current);
      }
    };
  }, [fetchJobs, pollIntervalMs]);

  return { ...state, refetch: fetchJobs };
}

export function useTrainingJobDetail(
  jobId: string,
  pollIntervalMs: number = 5000,
) {
  const [state, setState] = useState<ApiState<TrainingJobDetail>>({
    data: null,
    loading: true,
    error: null,
  });
  const mountedRef = useRef(true);
  const pollTimerRef = useRef<NodeJS.Timeout | undefined>(undefined);

  const fetchDetail = useCallback(async () => {
    try {
      const data = await apiCall<TrainingJobDetail>(
        `/api/training/jobs/${encodeURIComponent(jobId)}`,
      );
      if (!mountedRef.current) return;
      setState({ data, loading: false, error: null });
    } catch (err) {
      if (!mountedRef.current) return;
      setState({
        data: null,
        loading: false,
        error:
          err instanceof Error ? err.message : "Failed to fetch job detail",
      });
    }
  }, [jobId]);

  useEffect(() => {
    mountedRef.current = true;
    fetchDetail();
    pollTimerRef.current = setInterval(fetchDetail, pollIntervalMs);
    return () => {
      mountedRef.current = false;
      if (pollTimerRef.current !== undefined) {
        clearInterval(pollTimerRef.current);
      }
    };
  }, [fetchDetail, pollIntervalMs]);

  return { ...state, refetch: fetchDetail };
}

export function useTrainingModels() {
  const [state, setState] = useState<ApiState<TrainingModel[]>>({
    data: null,
    loading: true,
    error: null,
  });
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    (async () => {
      try {
        const data = await apiCall<{ models: TrainingModel[] }>(
          "/api/training/models",
        );
        if (!mountedRef.current) return;
        setState({ data: data.models, loading: false, error: null });
      } catch (err) {
        if (!mountedRef.current) return;
        setState({
          data: null,
          loading: false,
          error: err instanceof Error ? err.message : "Failed to fetch models",
        });
      }
    })();

    return () => {
      mountedRef.current = false;
    };
  }, []);

  return state;
}

export function useInferenceEndpoints(pollIntervalMs: number = 30000) {
  const [state, setState] = useState<ApiState<InferenceEndpoint[]>>({
    data: null,
    loading: true,
    error: null,
  });
  const mountedRef = useRef(true);
  const pollTimerRef = useRef<NodeJS.Timeout | undefined>(undefined);

  const fetchEndpoints = useCallback(async () => {
    try {
      const data = await apiCall<{ endpoints: InferenceEndpoint[] }>(
        "/api/training/inference/endpoints",
      );
      if (!mountedRef.current) return;
      setState({ data: data.endpoints, loading: false, error: null });
    } catch (err) {
      if (!mountedRef.current) return;
      setState({
        data: null,
        loading: false,
        error: err instanceof Error ? err.message : "Failed to fetch endpoints",
      });
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    fetchEndpoints();
    pollTimerRef.current = setInterval(fetchEndpoints, pollIntervalMs);
    return () => {
      mountedRef.current = false;
      if (pollTimerRef.current !== undefined) {
        clearInterval(pollTimerRef.current);
      }
    };
  }, [fetchEndpoints, pollIntervalMs]);

  return { ...state, refetch: fetchEndpoints };
}

export function useInferenceStats(
  label: string,
  lastMinutes: number = 30,
  pollIntervalMs: number = 30000,
) {
  const [state, setState] = useState<ApiState<InferenceStats>>({
    data: null,
    loading: true,
    error: null,
  });
  const mountedRef = useRef(true);
  const pollTimerRef = useRef<NodeJS.Timeout | undefined>(undefined);

  const fetchStats = useCallback(async () => {
    try {
      const params = new URLSearchParams({
        label,
        last_minutes: String(lastMinutes),
      });
      const data = await apiCall<InferenceStats>(
        `/api/training/inference/stats?${params}`,
      );
      if (!mountedRef.current) return;
      setState({ data, loading: false, error: null });
    } catch (err) {
      if (!mountedRef.current) return;
      setState({
        data: null,
        loading: false,
        error: err instanceof Error ? err.message : "Failed to fetch stats",
      });
    }
  }, [label, lastMinutes]);

  useEffect(() => {
    mountedRef.current = true;
    fetchStats();
    pollTimerRef.current = setInterval(fetchStats, pollIntervalMs);
    return () => {
      mountedRef.current = false;
      if (pollTimerRef.current !== undefined) {
        clearInterval(pollTimerRef.current);
      }
    };
  }, [fetchStats, pollIntervalMs]);

  return state;
}

export function useCreateTrainingJob() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = useCallback(async (request: CreateJobRequest) => {
    setLoading(true);
    setError(null);
    try {
      const result = await apiCall<{ job_id: string }>("/api/training/jobs", {
        method: "POST",
        body: JSON.stringify(request),
      });
      setLoading(false);
      return result.job_id;
    } catch (err) {
      const errorMsg =
        err instanceof Error ? err.message : "Failed to create job";
      setError(errorMsg);
      setLoading(false);
      throw err;
    }
  }, []);

  return { create, loading, error };
}

export function useCancelTrainingJob() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cancel = useCallback(async (jobId: string) => {
    setLoading(true);
    setError(null);
    try {
      await apiCall<void>(
        `/api/training/jobs/${encodeURIComponent(jobId)}/cancel`,
        {
          method: "POST",
        },
      );
      setLoading(false);
    } catch (err) {
      const errorMsg =
        err instanceof Error ? err.message : "Failed to cancel job";
      setError(errorMsg);
      setLoading(false);
      throw err;
    }
  }, []);

  return { cancel, loading, error };
}

export function useEvalTrainingJob() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const eval_ = useCallback(async (jobId: string) => {
    setLoading(true);
    setError(null);
    try {
      await apiCall<void>(
        `/api/training/jobs/${encodeURIComponent(jobId)}/eval`,
        {
          method: "POST",
        },
      );
      setLoading(false);
    } catch (err) {
      const errorMsg =
        err instanceof Error ? err.message : "Failed to trigger eval";
      setError(errorMsg);
      setLoading(false);
      throw err;
    }
  }, []);

  return { eval: eval_, loading, error };
}

export function useJobLogs(jobId: string, tail: number = 200) {
  const [state, setState] = useState<ApiState<string[]>>({
    data: null,
    loading: true,
    error: null,
  });
  const mountedRef = useRef(true);

  const fetchLogs = useCallback(async () => {
    try {
      const params = new URLSearchParams({ tail: String(tail) });
      const data = await apiCall<{ lines: string[] }>(
        `/api/training/jobs/${encodeURIComponent(jobId)}/logs?${params}`,
      );
      if (!mountedRef.current) return;
      setState({ data: data.lines, loading: false, error: null });
    } catch (err) {
      if (!mountedRef.current) return;
      setState({
        data: null,
        loading: false,
        error: err instanceof Error ? err.message : "Failed to fetch logs",
      });
    }
  }, [jobId, tail]);

  useEffect(() => {
    mountedRef.current = true;
    fetchLogs();
    return () => {
      mountedRef.current = false;
    };
  }, [fetchLogs]);

  return { ...state, refetch: fetchLogs };
}

/**
 * Polls `/api/training/vast/jobs/:id/budget` for the running cost
 * snapshot of one job. Returns `data: null` when the job has no
 * provisioned instance yet (the panel shows a placeholder) and an
 * `error` message when the request itself fails.
 */
export function useTrainingBudget(jobId: string, pollIntervalMs: number = 15000) {
  const [state, setState] = useState<ApiState<TrainingBudget | null>>({
    data: null,
    loading: true,
    error: null,
  });
  const mountedRef = useRef(true);
  const pollTimerRef = useRef<NodeJS.Timeout | undefined>(undefined);

  const fetchBudget = useCallback(async () => {
    try {
      const data = await apiCall<{ budget: TrainingBudget | null }>(
        `/api/training/vast/jobs/${encodeURIComponent(jobId)}/budget`,
      );
      if (!mountedRef.current) return;
      setState({ data: data.budget, loading: false, error: null });
    } catch (err) {
      if (!mountedRef.current) return;
      setState({
        data: null,
        loading: false,
        error:
          err instanceof Error ? err.message : "Failed to fetch budget",
      });
    }
  }, [jobId]);

  useEffect(() => {
    mountedRef.current = true;
    fetchBudget();
    pollTimerRef.current = setInterval(fetchBudget, pollIntervalMs);
    return () => {
      mountedRef.current = false;
      if (pollTimerRef.current !== undefined) {
        clearInterval(pollTimerRef.current);
      }
    };
  }, [fetchBudget, pollIntervalMs]);

  return { ...state, refetch: fetchBudget };
}

export function useDeleteInferenceEndpoint() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const delete_ = useCallback(async (endpointId: string) => {
    setLoading(true);
    setError(null);
    try {
      await apiCall<void>(
        `/api/training/inference/endpoints/${encodeURIComponent(endpointId)}`,
        { method: "DELETE" },
      );
      setLoading(false);
    } catch (err) {
      const errorMsg =
        err instanceof Error ? err.message : "Failed to delete endpoint";
      setError(errorMsg);
      setLoading(false);
      throw err;
    }
  }, []);

  return { delete: delete_, loading, error };
}

export function useCreateInferenceEndpoint() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = useCallback(
    async (endpoint: Omit<InferenceEndpoint, "id">) => {
      setLoading(true);
      setError(null);
      try {
        const result = await apiCall<{ id: string }>(
          "/api/training/inference/endpoints",
          {
            method: "POST",
            body: JSON.stringify(endpoint),
          },
        );
        setLoading(false);
        return result.id;
      } catch (err) {
        const errorMsg =
          err instanceof Error ? err.message : "Failed to create endpoint";
        setError(errorMsg);
        setLoading(false);
        throw err;
      }
    },
    [],
  );

  return { create, loading, error };
}
