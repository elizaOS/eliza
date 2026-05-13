/**
 * State — InterruptBench's in-process model of the world.
 *
 * Tracks just enough state for the scorer to evaluate end conditions:
 *
 *   - WorkThreads (id, owner, status, instruction, roomId)
 *   - ScheduledTasks
 *   - PendingPrompts
 *   - Replies per channel (sent by the agent during the run)
 *   - External side effects (emailsSent count, etc.)
 *
 * This is intentionally NOT a full runtime — the runtime under test (the
 * Stage-1 response handler + threadOps field evaluator) emits intent, and
 * the harness reflects those intents back into this State as if a real
 * lifeops_thread_control action ran. That's the layer we're benchmarking.
 */

import type {
  ScenarioOpenThread,
  ScenarioPendingPrompt,
  ScenarioScheduledTask,
  ScenarioSetup,
} from "./types.ts";

interface ReplyRecord {
  channel: string;
  text: string;
  /** Virtual ms when the agent emitted it. */
  emittedAt: number;
}

interface ThreadState extends ScenarioOpenThread {}

interface PendingPromptState extends ScenarioPendingPrompt {
  resolved: boolean;
  resolvedAt?: number;
}

interface ScheduledTaskState extends ScenarioScheduledTask {}

interface ExternalSideEffects {
  emailsSent: number;
}

export class SimulatorState {
  threads = new Map<string, ThreadState>();
  scheduledTasks: ScheduledTaskState[] = [];
  pendingPrompts = new Map<string, PendingPromptState>();
  replies: ReplyRecord[] = [];
  external: ExternalSideEffects = { emailsSent: 0 };

  static fromSetup(setup: ScenarioSetup): SimulatorState {
    const s = new SimulatorState();
    for (const t of setup.openThreads) {
      s.threads.set(t.id, { ...t });
    }
    for (const task of setup.scheduledTasks) {
      s.scheduledTasks.push({ ...task });
    }
    for (const p of setup.pendingPrompts ?? []) {
      s.pendingPrompts.set(p.id, { ...p, resolved: false });
    }
    return s;
  }

  /** Returns a deep enough copy for the scorer — sufficient for read-only use. */
  snapshot(): SimulatorState {
    const copy = new SimulatorState();
    for (const [id, t] of this.threads) copy.threads.set(id, { ...t });
    copy.scheduledTasks = this.scheduledTasks.map((t) => ({ ...t }));
    for (const [id, p] of this.pendingPrompts) {
      copy.pendingPrompts.set(id, { ...p });
    }
    copy.replies = this.replies.map((r) => ({ ...r }));
    copy.external = { ...this.external };
    return copy;
  }

  recordReply(channel: string, text: string, emittedAt: number): void {
    this.replies.push({ channel, text, emittedAt });
  }

  countRepliesInChannel(channel: string): number {
    return this.replies.reduce((n, r) => (r.channel === channel ? n + 1 : n), 0);
  }

  repliesInChannel(channel: string): ReplyRecord[] {
    return this.replies.filter((r) => r.channel === channel);
  }
}
