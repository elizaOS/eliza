import { useState, useMemo, useCallback } from 'react';
import type { ProcessedTrial, TrialStatus } from '../types/metrics';

export interface FilterState {
  jobName: string | null;
  agents: string[];
  models: string[];
  tasks: string[];
  statuses: TrialStatus[];
  searchQuery: string;
}

const initialFilterState: FilterState = {
  jobName: null,
  agents: [],
  models: [],
  tasks: [],
  statuses: [],
  searchQuery: '',
};

export function useMetricsFilter(trials: ProcessedTrial[]) {
  const [filters, setFilters] = useState<FilterState>(initialFilterState);

  const availableFilters = useMemo(() => {
    const jobs = new Set<string>();
    const agents = new Set<string>();
    const models = new Set<string>();
    const tasks = new Set<string>();

    trials.forEach((trial) => {
      jobs.add(trial.jobName);
      agents.add(trial.agent);
      models.add(trial.model);
      tasks.add(trial.taskName);
    });

    return {
      jobs: Array.from(jobs).sort(),
      agents: Array.from(agents).sort(),
      models: Array.from(models).sort(),
      tasks: Array.from(tasks).sort(),
    };
  }, [trials]);

  const filteredTrials = useMemo(() => {
    return trials.filter((trial) => {
      if (filters.jobName && trial.jobName !== filters.jobName) return false;
      if (filters.agents.length && !filters.agents.includes(trial.agent)) return false;
      if (filters.models.length && !filters.models.includes(trial.model)) return false;
      if (filters.tasks.length && !filters.tasks.includes(trial.taskName)) return false;
      if (filters.statuses.length && !filters.statuses.includes(trial.status)) return false;
      if (filters.searchQuery) {
        const query = filters.searchQuery.toLowerCase();
        const searchable = `${trial.taskName} ${trial.agent} ${trial.model} ${trial.trialName}`.toLowerCase();
        if (!searchable.includes(query)) return false;
      }
      return true;
    });
  }, [trials, filters]);

  const setJobName = useCallback((jobName: string | null) => {
    setFilters((prev) => ({ ...prev, jobName }));
  }, []);

  const setAgents = useCallback((agents: string[]) => {
    setFilters((prev) => ({ ...prev, agents }));
  }, []);

  const setModels = useCallback((models: string[]) => {
    setFilters((prev) => ({ ...prev, models }));
  }, []);

  const setTasks = useCallback((tasks: string[]) => {
    setFilters((prev) => ({ ...prev, tasks }));
  }, []);

  const setStatuses = useCallback((statuses: TrialStatus[]) => {
    setFilters((prev) => ({ ...prev, statuses }));
  }, []);

  const setSearchQuery = useCallback((searchQuery: string) => {
    setFilters((prev) => ({ ...prev, searchQuery }));
  }, []);

  const clearFilters = useCallback(() => {
    setFilters(initialFilterState);
  }, []);

  const hasActiveFilters = useMemo(() => {
    return (
      filters.jobName !== null ||
      filters.agents.length > 0 ||
      filters.models.length > 0 ||
      filters.tasks.length > 0 ||
      filters.statuses.length > 0 ||
      filters.searchQuery !== ''
    );
  }, [filters]);

  return {
    filters,
    filteredTrials,
    availableFilters,
    setJobName,
    setAgents,
    setModels,
    setTasks,
    setStatuses,
    setSearchQuery,
    clearFilters,
    hasActiveFilters,
  };
}
