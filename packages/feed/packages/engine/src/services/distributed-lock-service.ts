/**
 * Distributed lock abstraction (engine-side).
 *
 * The engine should not depend on `@feed/api` (Next.js / Redis / edge-specific),
 * but some workflows still need best-effort locking to avoid race conditions.
 *
 * By default this uses an in-memory lock (single-process). The web/api layer can
 * provide a real distributed implementation via `setDistributedLockProvider`.
 */

export type DistributedLockParams = {
  lockId: string;
  durationMs: number;
  operation: string;
  processId: string;
};

export interface DistributedLockProvider {
  acquireLock(params: DistributedLockParams): Promise<boolean>;
  releaseLock(lockId: string, processId: string): Promise<void>;
}

class InMemoryDistributedLockProvider implements DistributedLockProvider {
  private locks = new Map<string, { expiresAt: number; processId: string }>();

  async acquireLock(params: DistributedLockParams): Promise<boolean> {
    const now = Date.now();
    const current = this.locks.get(params.lockId);

    if (current && current.expiresAt > now) {
      return false;
    }

    this.locks.set(params.lockId, {
      expiresAt: now + Math.max(0, params.durationMs),
      processId: params.processId,
    });

    return true;
  }

  async releaseLock(lockId: string, processId: string): Promise<void> {
    const current = this.locks.get(lockId);
    if (!current) return;
    if (current.processId !== processId) return;
    this.locks.delete(lockId);
  }
}

let provider: DistributedLockProvider = new InMemoryDistributedLockProvider();

export function setDistributedLockProvider(
  next: DistributedLockProvider
): void {
  provider = next;
}

export class DistributedLockService {
  static acquireLock(params: DistributedLockParams): Promise<boolean> {
    return provider.acquireLock(params);
  }

  static releaseLock(lockId: string, processId: string): Promise<void> {
    return provider.releaseLock(lockId, processId);
  }
}
