import type { PolicyRule } from "@stwd/sdk";
import { useCallback, useEffect, useState } from "react";
import { useStewardContext } from "../provider.js";

/**
 * Policy CRUD with save and template support.
 */
export function usePolicies() {
  const { client, agentId, tenantConfig } = useStewardContext();
  const [policies, setPoliciesState] = useState<PolicyRule[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const fetchPolicies = useCallback(async () => {
    try {
      const data = await client.getPolicies(agentId);
      setPoliciesState(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setIsLoading(false);
    }
  }, [client, agentId]);

  useEffect(() => {
    fetchPolicies();
  }, [fetchPolicies]);

  const setPolicies = useCallback(
    async (newPolicies: PolicyRule[]) => {
      setIsSaving(true);
      try {
        await client.setPolicies(agentId, newPolicies);
        setPoliciesState(newPolicies);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err : new Error(String(err)));
        throw err;
      } finally {
        setIsSaving(false);
      }
    },
    [client, agentId],
  );

  const applyTemplate = useCallback(
    async (templateId: string, overrides?: Record<string, unknown>) => {
      const template = tenantConfig?.policyTemplates.find((t) => t.id === templateId);
      if (!template) {
        throw new Error(`Template "${templateId}" not found`);
      }

      const policies = structuredClone(template.policies);

      // Apply field overrides
      if (overrides) {
        for (const [path, value] of Object.entries(overrides)) {
          const [policyType, ...fieldPath] = path.split(".");
          const policy = policies.find((p) => p.type === policyType);
          if (policy && fieldPath.length > 0) {
            let target: Record<string, unknown> = policy.config;
            for (let i = 0; i < fieldPath.length - 1; i++) {
              target = target[fieldPath[i]] as Record<string, unknown>;
            }
            target[fieldPath[fieldPath.length - 1]] = value;
          }
        }
      }

      await setPolicies(policies);
    },
    [tenantConfig, setPolicies],
  );

  return {
    policies,
    isLoading,
    error,
    setPolicies,
    applyTemplate,
    isSaving,
    refetch: fetchPolicies,
  };
}
