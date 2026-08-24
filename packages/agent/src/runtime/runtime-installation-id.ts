/** Persists the standalone host identity used to scope runtime-owned effects. */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { UUID } from "@elizaos/core";

const INSTALLATION_ID_FILENAME = "runtime-installation-id";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function readInstallationId(target: string): Promise<UUID | undefined> {
  try {
    const value = (await fs.readFile(target, "utf8")).trim();
    if (!UUID_PATTERN.test(value)) {
      throw new Error(`Runtime installation identity is corrupt: ${target}`);
    }
    return value.toLowerCase() as UUID;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Loads one durable UUID per state directory, publishing it without replacement. */
export async function loadOrCreateRuntimeInstallationId(
  stateDirectory: string,
): Promise<UUID> {
  await fs.mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const target = path.join(stateDirectory, INSTALLATION_ID_FILENAME);
  const existing = await readInstallationId(target);
  if (existing) return existing;

  const candidate = randomUUID() as UUID;
  const temporary = path.join(
    stateDirectory,
    `.${INSTALLATION_ID_FILENAME}.${randomUUID()}.tmp`,
  );
  const file = await fs.open(temporary, "wx", 0o600);
  try {
    await file.writeFile(`${candidate}\n`, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await fs.link(temporary, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    await fs.unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      // error-policy:J2 A cleanup failure makes publication durability
      // ambiguous, so retain the original filesystem error for the boot boundary.
      if (error.code !== "ENOENT") throw error;
    });
  }
  await fs.chmod(target, 0o600);
  const directory = await fs.open(stateDirectory, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
  const published = await readInstallationId(target);
  if (!published)
    throw new Error("Runtime installation identity was not published.");
  return published;
}
