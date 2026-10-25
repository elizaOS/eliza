/**
 * Selects the broad PR bootstrap only where affected workspace builds cannot
 * establish ownership. Shared setup, deleted owners, and unknown paths retain
 * the existing core sweep; the on-demand CodeQL partition has no runtime input.
 */
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { execFileSync } from "./lib/spawn-sync-captured.ts";
import { listPackages } from "./lib/workspaces.ts";

export function planPrCoreBuild({ repoRoot = process.cwd(), base }) {
  if (!/^[0-9a-f]{40}$/.test(base ?? "")) {
    throw new Error("PR build scope requires a full merge-base SHA");
  }
  const git = (...args) =>
    execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  git("diff", "--quiet", "HEAD", "--");
  const head = git("rev-parse", "--verify", "HEAD^{commit}").trim();
  git("merge-base", "--is-ancestor", base, head);
  const trackedManifests = new Set(
    git("ls-files", "--cached", "-z", "--", ":(glob)**/package.json")
      .split("\0")
      .filter(Boolean),
  );
  const owners = listPackages({ repoRoot })
    .filter(({ dir }) => trackedManifests.has(`${dir}/package.json`))
    .sort((a, b) => b.dir.length - a.dir.length);
  // Disable rename folding so a moved shared input retains its old boundary.
  const changedPaths = git(
    "diff",
    "--name-only",
    "--no-renames",
    "-z",
    base,
    head,
    "--",
  )
    .split("\0")
    .filter(Boolean);
  const broadInputs = changedPaths.filter((file) => {
    if (file === ".github/workflows/codeql.yml") return false;
    // Script helpers and manifest edges may serve callers outside this owner.
    if (/(?:^|\/)scripts\//.test(file) || file.endsWith("/package.json"))
      return true;
    const owner = owners.find(({ dir }) => file.startsWith(`${dir}/`));
    return (
      typeof owner?.name !== "string" ||
      owner.name.length === 0 ||
      typeof owner.packageJson.scripts?.build !== "string" ||
      owner.packageJson.scripts.build.trim().length === 0
    );
  });
  return {
    base,
    head,
    changedPaths,
    broadInputs,
    required: broadInputs.length > 0,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const [base, output, ...extra] = process.argv.slice(2);
    if (!output || extra.length) {
      throw new Error(
        "Usage: pr-core-build-scope.ts <merge-base> <github-output>",
      );
    }
    const plan = planPrCoreBuild({ base });
    appendFileSync(output, `core_bootstrap_required=${plan.required}\n`);
    console.log(JSON.stringify(plan));
  } catch (error) {
    // error-policy:J1 Invalid Git or workspace state must not emit a skip output.
    console.error(error.message);
    process.exitCode = 1;
  }
}
