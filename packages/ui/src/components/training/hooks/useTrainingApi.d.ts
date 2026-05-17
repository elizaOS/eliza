import type { CreateJobRequest, InferenceEndpoint, InferenceStats, TrainingBudget, TrainingJob, TrainingJobDetail, TrainingModel } from "../types";
interface ApiState<T> {
    data: T | null;
    loading: boolean;
    error: string | null;
}
export declare function useTrainingJobs(pollIntervalMs?: number): {
    refetch: () => Promise<void>;
    data: TrainingJob[] | null;
    loading: boolean;
    error: string | null;
};
export declare function useTrainingJobDetail(jobId: string, pollIntervalMs?: number): {
    refetch: () => Promise<void>;
    data: TrainingJobDetail | null;
    loading: boolean;
    error: string | null;
};
export declare function useTrainingModels(): ApiState<TrainingModel[]>;
export declare function useInferenceEndpoints(pollIntervalMs?: number): {
    refetch: () => Promise<void>;
    data: InferenceEndpoint[] | null;
    loading: boolean;
    error: string | null;
};
export declare function useInferenceStats(label: string, lastMinutes?: number, pollIntervalMs?: number): ApiState<InferenceStats>;
export declare function useCreateTrainingJob(): {
    create: (request: CreateJobRequest) => Promise<string>;
    loading: boolean;
    error: string | null;
};
export declare function useCancelTrainingJob(): {
    cancel: (jobId: string) => Promise<void>;
    loading: boolean;
    error: string | null;
};
export declare function useEvalTrainingJob(): {
    eval: (jobId: string) => Promise<void>;
    loading: boolean;
    error: string | null;
};
export declare function useJobLogs(jobId: string, tail?: number): {
    refetch: () => Promise<void>;
    data: string[] | null;
    loading: boolean;
    error: string | null;
};
/**
 * Polls `/api/training/vast/jobs/:id/budget` for the running cost
 * snapshot of one job. Returns `data: null` when the job has no
 * provisioned instance yet (the panel shows a placeholder) and an
 * `error` message when the request itself fails.
 */
export declare function useTrainingBudget(jobId: string, pollIntervalMs?: number): {
    refetch: () => Promise<void>;
    data: TrainingBudget | null;
    loading: boolean;
    error: string | null;
};
export declare function useDeleteInferenceEndpoint(): {
    delete: (endpointId: string) => Promise<void>;
    loading: boolean;
    error: string | null;
};
export declare function useCreateInferenceEndpoint(): {
    create: (endpoint: Omit<InferenceEndpoint, "id">) => Promise<string>;
    loading: boolean;
    error: string | null;
};
export {};
//# sourceMappingURL=useTrainingApi.d.ts.map