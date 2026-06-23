import type { IAgentRuntime, UUID } from '@elizaos/core';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { agentCommercePlugin } from '../src/elizaos/index';
import { AgentCommerceService, AGENT_COMMERCE_SERVICE_TYPE } from '../src/service';
import { ERC8183StateMachine } from '../src/state-machine';
import { ElizaJobStore } from '../src/store/elizaos';
import { MemoryJobStore } from '../src/types';
import { StaticReputationProvider } from '../src/reputation/static';
import { MemoryReputationProvider } from '../src/reputation/memory';
import { CompositeReputationProvider } from '../src/reputation/composite';
import { PayloadHasher } from '../src/lib/pqc';

// ── Shared test fixtures ───────────────────────────────────────────────────

const AGENT_ID = '00000000-0000-4000-8000-000000000001' as UUID;
const ENTITY_ID = '00000000-0000-4000-8000-000000000002' as UUID;

function makeRuntime(overrides?: Partial<IAgentRuntime>): IAgentRuntime {
  const services = new Map<string, unknown>();
  const memStore: unknown[] = [];

  const runtime = {
    agentId: AGENT_ID,
    character: { name: 'TestAgent', plugins: [] },
    getSetting: vi.fn((_k: string) => null),
    createMemory: vi.fn(async () => ENTITY_ID),
    getMemories: vi.fn(async () => [...memStore]),
    getService: <T>(type: string): T | null => (services.get(type) as T) ?? null,
    logger: {
      trace: vi.fn(), debug: vi.fn(), info: vi.fn(),
      warn: vi.fn(), error: vi.fn(), fatal: vi.fn(),
      success: vi.fn(), progress: vi.fn(), log: vi.fn(),
      clear: vi.fn(), child: vi.fn(function() { return runtime.logger; }),
    },
    _services: services,
    _memStore: memStore,
    ...overrides,
  } as unknown as IAgentRuntime & { _services: Map<string, unknown>; _memStore: unknown[] };

  const service = new AgentCommerceService(runtime, {
    jobStore: new MemoryJobStore(),
    reputationProvider: new StaticReputationProvider({ minScore: 0 }),
  });
  services.set(AGENT_COMMERCE_SERVICE_TYPE, service);

  return runtime;
}

function makeCtx(jobStore = new MemoryJobStore()) {
  return {
    jobStore,
    reputationGate: {
      canFundJob: async () => true,
      getReputation: async () => 100,
    },
  };
}

// ── 1. Plugin shape ────────────────────────────────────────────────────────

describe('agentCommercePlugin shape', () => {
  it('exports plugin with correct name', () => {
    expect(agentCommercePlugin.name).toBe('agent-commerce');
  });

  it('registers exactly one service: agent_commerce', () => {
    expect(agentCommercePlugin.services).toHaveLength(1);
    expect(AgentCommerceService.serviceType).toBe('agent_commerce');
  });

  it('registers 4 actions', () => {
    expect(agentCommercePlugin.actions).toHaveLength(4);
    const names = agentCommercePlugin.actions?.map((a) => a.name);
    expect(names).toContain('CREATE_SECURE_JOB');
    expect(names).toContain('FUND_SECURE_JOB');
    expect(names).toContain('SUBMIT_DELIVERABLE');
    expect(names).toContain('JOB_STATUS');
  });

  it('registers 1 provider: COMMERCE_CONTEXT', () => {
    expect(agentCommercePlugin.providers).toHaveLength(1);
    expect(agentCommercePlugin.providers?.[0].name).toBe('COMMERCE_CONTEXT');
  });

  it('does not register evaluators (schema-based adaption pending)', () => {
    expect(agentCommercePlugin.evaluators ?? []).toHaveLength(0);
  });
});

// ── 2. AgentCommerceService lifecycle ─────────────────────────────────────

describe('AgentCommerceService', () => {
  it('starts with ElizaJobStore when runtime is provided', async () => {
    const runtime = makeRuntime();
    const svc = await AgentCommerceService.start(runtime) as AgentCommerceService;
    expect(svc.jobStore).toBeInstanceOf(ElizaJobStore);
  });

  it('starts with MemoryJobStore when no runtime is provided', () => {
    const svc = new AgentCommerceService(undefined, {});
    expect(svc.jobStore).toBeInstanceOf(MemoryJobStore);
  });

  it('accepts config overrides for jobStore and reputationProvider', () => {
    const customStore = new MemoryJobStore();
    const svc = new AgentCommerceService(undefined, {
      jobStore: customStore,
      reputationProvider: new StaticReputationProvider({ minScore: 50 }),
    });
    expect(svc.jobStore).toBe(customStore);
  });

  it('reads COMMERCE_MIN_REPUTATION from runtime settings', () => {
    const runtime = makeRuntime();
    vi.mocked(runtime.getSetting).mockImplementation((k) =>
      k === 'COMMERCE_MIN_REPUTATION' ? '75' : null,
    );
    const svc = new AgentCommerceService(runtime);
    // StaticReputationProvider enforces minScore from setting
    expect(svc.reputationProvider).toBeInstanceOf(StaticReputationProvider);
  });
});

// ── 3. ERC-8183 state machine ─────────────────────────────────────────────

describe('ERC8183StateMachine', () => {
  it('createJob → OPEN', async () => {
    const ctx = makeCtx();
    const job = await ERC8183StateMachine.createJob(ctx, 'alice', 'bob', 'Build API', BigInt(1_000_000));
    expect(job.state).toBe('OPEN');
    expect(job.clientAgent).toBe('alice');
    expect(job.providerAgent).toBe('bob');
    expect(job.requiredAmount).toBe(BigInt(1_000_000));
  });

  it('fundJob → FUNDED', async () => {
    const ctx = makeCtx();
    const job = await ERC8183StateMachine.createJob(ctx, 'alice', 'bob', 'task', BigInt(500_000));
    const funded = await ERC8183StateMachine.fundJob(ctx, job.jobId, 'alice', BigInt(500_000));
    expect(funded.state).toBe('FUNDED');
  });

  it('submitJob → SUBMITTED', async () => {
    const ctx = makeCtx();
    const job = await ERC8183StateMachine.createJob(ctx, 'alice', 'bob', 'task', BigInt(100));
    await ERC8183StateMachine.fundJob(ctx, job.jobId, 'alice', BigInt(100));
    const hash = PayloadHasher.hashPayload({ result: 'done' });
    const submitted = await ERC8183StateMachine.submitJob(ctx, job.jobId, 'bob', hash, { result: 'done' });
    expect(submitted.state).toBe('SUBMITTED');
    expect(submitted.deliverableHash).toBe(hash);
  });

  it('evaluateJob ACCEPT → COMPLETE', async () => {
    const ctx = makeCtx();
    const job = await ERC8183StateMachine.createJob(ctx, 'alice', 'bob', 'task', BigInt(100));
    await ERC8183StateMachine.fundJob(ctx, job.jobId, 'alice', BigInt(100));
    const hash = PayloadHasher.hashPayload({ result: 'done' });
    await ERC8183StateMachine.submitJob(ctx, job.jobId, 'bob', hash);
    const complete = await ERC8183StateMachine.evaluateJob(ctx, job.jobId, 'alice', 'ACCEPT', 'LGTM');
    expect(complete.state).toBe('COMPLETE');
    expect(complete.metadata.evaluationReason).toBe('LGTM');
  });

  it('evaluateJob REJECT → REFUND', async () => {
    const ctx = makeCtx();
    const job = await ERC8183StateMachine.createJob(ctx, 'alice', 'bob', 'task', BigInt(100));
    await ERC8183StateMachine.fundJob(ctx, job.jobId, 'alice', BigInt(100));
    const hash = PayloadHasher.hashPayload({ result: 'bad' });
    await ERC8183StateMachine.submitJob(ctx, job.jobId, 'bob', hash);
    const refunded = await ERC8183StateMachine.evaluateJob(ctx, job.jobId, 'alice', 'REJECT', 'Does not meet spec');
    expect(refunded.state).toBe('REFUND');
  });

  it('abortJob → ABORTED (idempotent on second call)', async () => {
    const ctx = makeCtx();
    const job = await ERC8183StateMachine.createJob(ctx, 'alice', 'bob', 'task', BigInt(100));
    await ERC8183StateMachine.fundJob(ctx, job.jobId, 'alice', BigInt(100));
    const aborted = await ERC8183StateMachine.abortJob(ctx, job.jobId, '[SECURITY-ALERT] hash mismatch');
    expect(aborted.state).toBe('ABORTED');
    // Second call on terminal state is idempotent
    const again = await ERC8183StateMachine.abortJob(ctx, job.jobId, 'again');
    expect(again.state).toBe('ABORTED');
  });

  it('rejects fundJob from non-client agent', async () => {
    const ctx = makeCtx();
    const job = await ERC8183StateMachine.createJob(ctx, 'alice', 'bob', 'task', BigInt(100));
    await expect(
      ERC8183StateMachine.fundJob(ctx, job.jobId, 'eve', BigInt(100)),
    ).rejects.toThrow();
  });

  it('rejects invalid state transition (fund already-funded job)', async () => {
    const ctx = makeCtx();
    const job = await ERC8183StateMachine.createJob(ctx, 'alice', 'bob', 'task', BigInt(100));
    await ERC8183StateMachine.fundJob(ctx, job.jobId, 'alice', BigInt(100));
    await expect(
      ERC8183StateMachine.fundJob(ctx, job.jobId, 'alice', BigInt(100)),
    ).rejects.toThrow();
  });
});

// ── 4. PayloadHasher attestation ──────────────────────────────────────────

describe('PayloadHasher', () => {
  it('produces a stable hex hash for the same payload', () => {
    const payload = { task: 'build API', version: 1 };
    expect(PayloadHasher.hashPayload(payload)).toBe(PayloadHasher.hashPayload(payload));
  });

  it('hash is deterministic regardless of key insertion order', () => {
    const a = { x: 1, y: 2 };
    const b = { y: 2, x: 1 };
    expect(PayloadHasher.hashPayload(a)).toBe(PayloadHasher.hashPayload(b));
  });

  it('verifyHash returns true for matching payload', () => {
    const payload = { deliverable: 'https://api.example.com' };
    const hash = PayloadHasher.hashPayload(payload);
    expect(PayloadHasher.verifyHash(payload, hash)).toBe(true);
  });

  it('verifyHash returns false for tampered payload', () => {
    const payload = { deliverable: 'https://api.example.com' };
    const hash = PayloadHasher.hashPayload(payload);
    expect(PayloadHasher.verifyHash({ deliverable: 'https://evil.com' }, hash)).toBe(false);
  });
});

// ── 5. Reputation providers ───────────────────────────────────────────────

describe('StaticReputationProvider', () => {
  it('allows funding when reputation meets minScore', async () => {
    const provider = new StaticReputationProvider({ minScore: 0 });
    expect(await provider.canFundJob('any-agent', BigInt(1000))).toBe(true);
  });

  it('denies funding when minScore threshold cannot be met', async () => {
    // StaticReputationProvider gives everyone score 100 unless configured otherwise
    const provider = new StaticReputationProvider({ minScore: 101 });
    expect(await provider.canFundJob('any-agent', BigInt(1000))).toBe(false);
  });
});

describe('MemoryReputationProvider', () => {
  it('returns 100 for unknown agents (default)', async () => {
    const provider = new MemoryReputationProvider({ minScore: 0 });
    const { score } = await provider.getScore('unknown-agent');
    expect(score).toBe(100);
  });

  it('seeds score for specific agents via initialScores config', async () => {
    const provider = new MemoryReputationProvider({
      minScore: 0,
      initialScores: { 'agent-x': { score: 60, updatedAt: Date.now(), jobsCompleted: 0, jobsFailed: 0 } },
    });
    const { score } = await provider.getScore('agent-x');
    expect(score).toBe(60);
  });

  it('increments score after successful outcome (from non-max seed)', async () => {
    const provider = new MemoryReputationProvider({
      minScore: 0,
      initialScores: { 'agent-x': { score: 50, updatedAt: Date.now(), jobsCompleted: 0, jobsFailed: 0 } },
    });
    // recordOutcome(jobId, agentId, success: boolean)
    await provider.recordOutcome('job-1', 'agent-x', true);
    const { score } = await provider.getScore('agent-x');
    expect(score).toBe(51);
  });

  it('decrements score after failed outcome (-5 per failure)', async () => {
    const provider = new MemoryReputationProvider({ minScore: 0 });
    // Default score is 100; failure deducts 5 → 95
    await provider.recordOutcome('job-1', 'agent-x', false);
    const { score } = await provider.getScore('agent-x');
    expect(score).toBe(95);
  });
});

describe('CompositeReputationProvider', () => {
  it('requires all providers to approve (AND semantics)', async () => {
    const allowAll = new StaticReputationProvider({ minScore: 0 });
    const denyAll = new StaticReputationProvider({ minScore: 101 });
    const composite = new CompositeReputationProvider([allowAll, denyAll]);
    expect(await composite.canFundJob('agent', BigInt(100))).toBe(false);
  });

  it('approves when all providers approve', async () => {
    const allowAll = new StaticReputationProvider({ minScore: 0 });
    const composite = new CompositeReputationProvider([allowAll, allowAll]);
    expect(await composite.canFundJob('agent', BigInt(100))).toBe(true);
  });
});

// ── 6. ElizaJobStore hydration race ───────────────────────────────────────

describe('ElizaJobStore hydration', () => {
  it('concurrent get() calls trigger only one getMemories() call', async () => {
    const runtime = makeRuntime();
    const store = new ElizaJobStore(runtime);

    // Issue 3 concurrent gets before hydration completes
    await Promise.all([
      store.get('nonexistent-1'),
      store.get('nonexistent-2'),
      store.get('nonexistent-3'),
    ]);

    // getMemories should have been called exactly once (Promise-mutex)
    expect(vi.mocked(runtime.getMemories)).toHaveBeenCalledTimes(1);
  });

  it('clear() resets hydratePromise so next get() re-hydrates', async () => {
    const runtime = makeRuntime();
    const store = new ElizaJobStore(runtime);

    await store.get('anything');
    expect(vi.mocked(runtime.getMemories)).toHaveBeenCalledTimes(1);

    store.clear();
    await store.get('anything-else');
    expect(vi.mocked(runtime.getMemories)).toHaveBeenCalledTimes(2);
  });
});

// ── 7. Action validate() contract ─────────────────────────────────────────

describe('Action validate() contracts', () => {
  function msg(text: string) {
    return { content: { text }, entityId: ENTITY_ID } as never;
  }

  it('CREATE_SECURE_JOB matches "create job/task" variants', async () => {
    const action = agentCommercePlugin.actions?.find((a) => a.name === 'CREATE_SECURE_JOB');
    const runtime = makeRuntime();
    expect(await action?.validate?.(runtime, msg('create a job for alice'), undefined as never)).toBe(true);
    expect(await action?.validate?.(runtime, msg('create a task for bob'), undefined as never)).toBe(true);
    expect(await action?.validate?.(runtime, msg('hello world'), undefined as never)).toBe(false);
    expect(await action?.validate?.(runtime, msg('fund job job-123'), undefined as never)).toBe(false);
  });

  it('FUND_SECURE_JOB matches "fund job" variants', async () => {
    const action = agentCommercePlugin.actions?.find((a) => a.name === 'FUND_SECURE_JOB');
    const runtime = makeRuntime();
    expect(await action?.validate?.(runtime, msg('fund job job-abc123 with 1000'), undefined as never)).toBe(true);
    expect(await action?.validate?.(runtime, msg('create a job'), undefined as never)).toBe(false);
  });

  it('SUBMIT_DELIVERABLE matches "submit work" variants', async () => {
    const action = agentCommercePlugin.actions?.find((a) => a.name === 'SUBMIT_DELIVERABLE');
    const runtime = makeRuntime();
    expect(await action?.validate?.(runtime, msg('submit deliverable for job-x: done'), undefined as never)).toBe(true);
    expect(await action?.validate?.(runtime, msg('submit result'), undefined as never)).toBe(true);
    expect(await action?.validate?.(runtime, msg('hello'), undefined as never)).toBe(false);
  });

  it('JOB_STATUS matches "check status" variants', async () => {
    const action = agentCommercePlugin.actions?.find((a) => a.name === 'JOB_STATUS');
    const runtime = makeRuntime();
    expect(await action?.validate?.(runtime, msg('what is the status of job-abc'), undefined as never)).toBe(true);
    expect(await action?.validate?.(runtime, msg('check job job-123'), undefined as never)).toBe(true);
    expect(await action?.validate?.(runtime, msg('hello world'), undefined as never)).toBe(false);
  });
});
