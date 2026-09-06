/**
 * Persists completed view measurements independently of Playwright worker memory.
 * The outer runner clears the output directory once per run; replacement workers
 * and retries reuse it. Each view/viewport has one atomic record matching its
 * latest capture, so no report writer needs a shared read-modify-write lock.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

interface AuditFindingKey {
  slug: string;
  viewport: string;
}

export async function writeAuditFinding<T extends AuditFindingKey>(
  outputDir: string,
  finding: T,
): Promise<void> {
  const directory = path.join(outputDir, "findings");
  await mkdir(directory, { recursive: true });
  const key = createHash("sha256")
    .update(JSON.stringify([finding.slug, finding.viewport]))
    .digest("hex");
  const temporary = path.join(directory, `${key}.${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(finding), "utf8");
  await rename(temporary, path.join(directory, `${key}.json`));
}

export async function readAuditFindings<T extends AuditFindingKey>(
  outputDir: string,
): Promise<T[]> {
  const directory = path.join(outputDir, "findings");
  await mkdir(directory, { recursive: true });
  const files = (await readdir(directory)).filter((file) =>
    file.endsWith(".json"),
  );
  const findings = await Promise.all(
    files.map(
      async (file) =>
        JSON.parse(await readFile(path.join(directory, file), "utf8")) as T,
    ),
  );
  return findings.sort(
    (a, b) =>
      a.slug.localeCompare(b.slug) || a.viewport.localeCompare(b.viewport),
  );
}
