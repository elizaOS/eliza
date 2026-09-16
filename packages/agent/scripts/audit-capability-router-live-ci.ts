/**
 * Validates the remote-capability live workflow's admission and result boundary.
 * Runtime provenance, report integrity, and endpoint behavior are tested by their
 * executable suites rather than by matching implementation text here.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";

const stepSchema = z.object({
  name: z.string().optional(),
  run: z.string().optional(),
  uses: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
});
export const liveWorkflowSchema = z.object({
  on: z.object({ workflow_dispatch: z.unknown() }).strict(),
  jobs: z.record(
    z.string(),
    z.object({
      if: z.string().optional(),
      needs: z.union([z.string(), z.array(z.string())]).optional(),
      steps: z.array(stepSchema).optional(),
    }),
  ),
});

export function validateCapabilityRouterLiveCi(source: string): string[] {
  const workflow = liveWorkflowSchema.parse(Bun.YAML.parse(source));
  const failures: string[] = [];
  for (const id of ["cloud-live-e2e", "provider-live-e2e"]) {
    const job = workflow.jobs[id];
    if (job?.if !== `\${{ inputs.suite == 'remote-capabilities' }}`) {
      failures.push(
        `${id}: live execution must require explicit suite selection`,
      );
    }
  }
  const validator = workflow.jobs["github-live-artifact-validate"];
  const required = ["cloud-live-e2e", "provider-live-e2e"];
  if (
    !Array.isArray(validator?.needs) ||
    required.some((id) => !validator.needs?.includes(id))
  ) {
    failures.push("Live artifact validation must wait for both producers");
  }
  if (
    validator?.if !==
    `\${{ always() && !cancelled() && inputs.suite == 'remote-capabilities' }}`
  ) {
    failures.push(
      "Live artifact validation must observe producer failures without running on unrelated suites",
    );
  }
  if (validator?.steps?.[0]?.name !== "Require live producers") {
    failures.push(
      "Live artifact validation must reject failed producers before downloading reports",
    );
  }
  return failures;
}

if (import.meta.main) {
  const failures = validateCapabilityRouterLiveCi(
    readFileSync(".github/workflows/live-smoke.yml", "utf8"),
  );
  if (failures.length > 0) throw new Error(failures.join("\n"));
  process.stdout.write(
    "Remote capability live admission and result boundary verified.\n",
  );
}
