// spec/agent/deviceActions/execution.md, "Dispatch needs an exact reservation and the agent's claim"; spec/agent/deviceActions/execution.md, "A settled result is durable before upload and upload never repeats the call"
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DeviceJournal, JournalEntry } from "../../src/client/device-execution.vibe";

const pendingByDirectory = new Map<string, Promise<unknown>>();

const fileName = (proposalId: string): string => `${Buffer.from(proposalId).toString("base64url")}.json`;

const revisionOf = (raw: unknown): number =>
  typeof raw === "object" && raw !== null && "revision" in raw && typeof raw.revision === "number" ? raw.revision : -1;

export interface FileJournal extends DeviceJournal {
  put(proposalId: string, entry: JournalEntry): Promise<void>;
  remove(proposalId: string): Promise<void>;
}

export async function fileJournal(directory: string): Promise<FileJournal> {
  await mkdir(directory, { recursive: true });
  const path = (proposalId: string) => join(directory, fileName(proposalId));
  const serial = <A>(work: () => Promise<A>): Promise<A> => {
    const next = (pendingByDirectory.get(directory) ?? Promise.resolve()).then(work, work);
    pendingByDirectory.set(directory, next);
    const complete = () => {
      if (pendingByDirectory.get(directory) === next) pendingByDirectory.delete(directory);
    };
    void next.then(complete, complete);
    return next;
  };
  const read = async (file: string): Promise<unknown> => {
    try {
      return JSON.parse(await readFile(file, "utf8")) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  };
  const write = async (proposalId: string, raw: unknown): Promise<void> => {
    const temporary = `${path(proposalId)}.next`;
    await writeFile(temporary, JSON.stringify(raw));
    await rename(temporary, path(proposalId));
  };
  return {
    get: (proposalId) => serial(() => read(path(proposalId))),
    put: (proposalId, entry) => serial(() => write(proposalId, entry)),
    remove: (proposalId) => serial(() => rm(path(proposalId), { force: true })),
    edit: (proposalId, expectedRevision, next: JournalEntry) =>
      serial(async () => {
        const current = await read(path(proposalId));
        if ((current === undefined ? 0 : revisionOf(current)) !== expectedRevision) return false;
        await write(proposalId, next);
        return true;
      }),
    list: () =>
      serial(async () => {
        const names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
        return await Promise.all(names.map((name) => read(join(directory, name))));
      }),
  };
}
