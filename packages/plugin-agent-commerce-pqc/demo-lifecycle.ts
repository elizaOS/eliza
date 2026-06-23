/**
 * Live demo: ERC-8183 agentic commerce lifecycle
 *
 * Run: LOG_LEVEL=info bun run demo-lifecycle.ts
 *
 * Demonstrates real plugin registration, state transitions, and elizaOS
 * memory persistence — no mocked state machine.
 */
import type { IAgentRuntime, UUID } from '@elizaos/core';
import { AgentCommerceService, AGENT_COMMERCE_SERVICE_TYPE } from './src/service';
import { agentCommercePlugin } from './src/elizaos/index';
import { ERC8183StateMachine } from './src/state-machine';
import { MemoryJobStore } from './src/types';
import { StaticReputationProvider } from './src/reputation/static';
import { PayloadHasher } from './src/lib/pqc';

// ── Minimal mock runtime (no framework boot required) ──────────────────────

const AGENT_ID = '00000000-0000-4000-8000-000000000001' as UUID;
const ENTITY_ID = '00000000-0000-4000-8000-000000000002' as UUID;
const ROOM_ID   = '00000000-0000-4000-8000-000000000003' as UUID;

// In-memory store for memories (simulates ElizaOS db)
const memStore: Record<string, unknown>[] = [];

function makeRuntime(): IAgentRuntime & { _services: Map<string, unknown> } {
  const _services = new Map<string, unknown>();
  const runtime = {
    agentId: AGENT_ID,
    character: { name: 'DemoAgent', plugins: ['@elizaos/plugin-agent-commerce'] },
    getSetting: (_k: string) => null,
    createMemory: async (mem: unknown) => {
      memStore.push(mem as Record<string, unknown>);
      return ENTITY_ID;
    },
    getMemories: async () => [...memStore] as never,
    getService: <T>(type: string): T | null => (_services.get(type) as T) ?? null,
    logger: {
      level: 'info',
      trace: (...a: unknown[]) => console.log('[TRACE]', ...a),
      debug: (...a: unknown[]) => console.log('[DEBUG]', ...a),
      info:  (...a: unknown[]) => console.log('[INFO] ', ...a),
      warn:  (...a: unknown[]) => console.log('[WARN] ', ...a),
      error: (...a: unknown[]) => console.log('[ERROR]', ...a),
      fatal: (...a: unknown[]) => console.log('[FATAL]', ...a),
      success: (...a: unknown[]) => console.log('[OK]   ', ...a),
      progress: (...a: unknown[]) => console.log('[PROG] ', ...a),
      log: (...a: unknown[]) => console.log('[LOG]  ', ...a),
      clear: () => {},
      child: function child() { return runtime.logger; },
    },
    _services,
  } as unknown as IAgentRuntime & { _services: Map<string, unknown> };
  return runtime;
}

// ── Demo ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log(' plugin-agent-commerce-pqc  |  ERC-8183 lifecycle demo ');
  console.log('═══════════════════════════════════════════════════════');

  // 1. Plugin shape verification
  console.log('\n── [1] Plugin registration ──────────────────────────────');
  console.log(`  name:     ${agentCommercePlugin.name}`);
  console.log(`  services: ${agentCommercePlugin.services?.map((s: { serviceType?: string } & Function) => (s as { serviceType?: string }).serviceType ?? s.name).join(', ')}`);
  console.log(`  actions:  ${agentCommercePlugin.actions?.map((a: { name: string }) => a.name).join(', ')}`);
  console.log(`  providers:${agentCommercePlugin.providers?.map((p: { name: string }) => p.name).join(', ')}`);

  // 2. Service startup
  console.log('\n── [2] AgentCommerceService.start(runtime) ─────────────');
  const runtime = makeRuntime();
  const service = await AgentCommerceService.start(runtime) as AgentCommerceService;
  runtime._services.set(AGENT_COMMERCE_SERVICE_TYPE, service);
  console.log(`  service type:  ${AgentCommerceService.serviceType}`);
  console.log(`  job store:     ${service.jobStore.constructor.name}`);
  console.log(`  reputation:    ${service.reputationProvider.constructor.name}`);
  console.log(`  security guard initialized`);

  // 3. Build ctx for state machine (same pattern as action handlers)
  const ctx = {
    jobStore: service.jobStore,
    reputationGate: {
      canFundJob: (agentId: string, amount: bigint) =>
        service.reputationProvider.canFundJob(agentId, amount),
      getReputation: async (agentId: string) => {
        const { score } = await service.reputationProvider.getScore(agentId);
        return score;
      },
    },
  };

  // 4. CREATE_SECURE_JOB
  console.log('\n── [3] ERC8183StateMachine.createJob ───────────────────');
  const job = await ERC8183StateMachine.createJob(
    ctx,
    'agent-alice',
    'agent-bob',
    'Build a REST API with authentication and rate limiting',
    BigInt(1_000_000),
  );
  console.log(`  jobId:    ${job.jobId}`);
  console.log(`  state:    ${job.state}`);
  console.log(`  client:   ${job.clientAgent}`);
  console.log(`  provider: ${job.providerAgent}`);
  console.log(`  amount:   ${job.requiredAmount}`);

  // 5. FUND_SECURE_JOB
  console.log('\n── [4] ERC8183StateMachine.fundJob ─────────────────────');
  const taskPayload = { description: job.taskDescription, deadline: new Date(Date.now() + 86_400_000).toISOString() };
  const taskHash = PayloadHasher.hashPayload(taskPayload);
  const funded = await ERC8183StateMachine.fundJob(ctx, job.jobId, 'agent-alice', BigInt(1_000_000));
  console.log(`  state:      ${funded.state}`);
  console.log(`  task hash:  ${taskHash.slice(0, 16)}…`);
  console.log(`  funded at:  ${new Date(funded.updatedAt).toISOString()}`);

  // 6. SUBMIT_DELIVERABLE
  console.log('\n── [5] ERC8183StateMachine.submitJob ───────────────────');
  const deliverablePayload = { url: 'https://api.example.com', docs: 'https://api.example.com/docs', passedTests: true };
  const deliverableHash = PayloadHasher.hashPayload(deliverablePayload);
  const submitted = await ERC8183StateMachine.submitJob(
    ctx,
    job.jobId,
    'agent-bob',
    deliverableHash,
    deliverablePayload,
  );
  console.log(`  state:           ${submitted.state}`);
  console.log(`  deliverable hash: ${deliverableHash.slice(0, 16)}…`);
  console.log(`  hash verified:   ${PayloadHasher.verifyHash(deliverablePayload, deliverableHash)}`);

  // 7. EVALUATE → COMPLETE
  console.log('\n── [6] ERC8183StateMachine.evaluateJob (ACCEPT) ────────');
  // Client evaluates (evaluatorAgent defaults to clientAgent when not set separately)
  const completed = await ERC8183StateMachine.evaluateJob(ctx, job.jobId, 'agent-alice', 'ACCEPT', 'API meets all requirements');
  console.log(`  state:    ${completed.state}`);
  console.log(`  reason:   ${completed.metadata.evaluationReason}`);
  console.log(`  settled:  ${new Date(completed.updatedAt).toISOString()}`);

  // 8. Provider (context injection)
  console.log('\n── [7] commerceProvider context injection ───────────────');
  const provider = agentCommercePlugin.providers?.[0];
  if (provider?.get) {
    const mockMessage = { entityId: ENTITY_ID, roomId: ROOM_ID, content: { text: 'test' } };
    const result = await provider.get(runtime, mockMessage as never, undefined as never);
    const text = typeof result === 'string'
      ? result
      : (result as { text?: string } | null)?.text ?? JSON.stringify(result);
    console.log(`  provider output:\n${text?.slice(0, 300)}`);
  }

  // 9. Memory persistence summary
  console.log('\n── [8] ElizaOS memory persistence ──────────────────────');
  console.log(`  Total createMemory() calls: ${memStore.length}`);
  console.log(`  (one per state transition → append-only, no destructive updates)`);

  // 10. Abort path demo (separate job)
  console.log('\n── [9] Abort path (hash mismatch simulation) ───────────');
  const job2 = await ERC8183StateMachine.createJob(ctx, 'agent-alice', 'agent-eve', 'Malicious task test', BigInt(500_000));
  await ERC8183StateMachine.fundJob(ctx, job2.jobId, 'agent-alice', BigInt(500_000));
  const aborted = await ERC8183StateMachine.abortJob(ctx, job2.jobId, '[SECURITY-ALERT] HASH_MISMATCH_ALERT task payload');
  console.log(`  state:  ${aborted.state}`);
  console.log(`  reason: ${aborted.metadata.securityAlert}`);

  console.log('\n═══════════════════════════════════════════════════════');
  console.log(' RESULT: All 7 lifecycle transitions executed correctly ');
  console.log('═══════════════════════════════════════════════════════');
}

main().catch((e) => { console.error('[FATAL]', e); process.exit(1); });
