/**
 * Process Registry - Manages running and finished shell sessions
 * Ported from otto bash-process-registry.ts
 */
import type { FinishedSession, ProcessSession, ProcessStatus } from "../types";
export declare function createSessionSlug(isTaken?: (id: string) => boolean): string;
export declare function addSession(session: ProcessSession): void;
export declare function getSession(id: string): ProcessSession | undefined;
export declare function getFinishedSession(id: string): FinishedSession | undefined;
export declare function deleteSession(id: string): void;
export declare function tail(text: string, max?: number): string;
export declare function trimWithCap(text: string, max: number): string;
export declare function appendOutput(
  session: ProcessSession,
  stream: "stdout" | "stderr",
  chunk: string
): void;
export declare function drainSession(session: ProcessSession): {
  stdout: string;
  stderr: string;
};
export declare function markExited(
  session: ProcessSession,
  exitCode: number | null,
  exitSignal: NodeJS.Signals | number | null,
  status: ProcessStatus
): void;
export declare function markBackgrounded(session: ProcessSession): void;
export declare function listRunningSessions(): ProcessSession[];
export declare function listFinishedSessions(): FinishedSession[];
export declare function clearFinished(): void;
export declare function resetProcessRegistryForTests(): void;
export declare function setJobTtlMs(value?: number): void;
