/** Types the repository path validation helpers used by TypeScript workspace tooling. */
export function normalizeGitRepositoryPath(
  value: unknown,
  label?: string,
): string;

export function assertUniqueRepositoryIdentities(
  values: Iterable<string>,
  label: string,
): void;

export function assertContainedRegularFile(
  repoRoot: string,
  relativePath: string,
  label: string,
): { absolute: string; relative: string };
