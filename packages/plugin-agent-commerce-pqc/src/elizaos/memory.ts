import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import type { Memory, IElizaRuntime } from './types.js';

function getMemoryDir(): string {
  return process.env.STVOR_MEMORY_DIR ?? './data/memory';
}

interface StoredMemory {
  agentId: string;
  roomId: string;
  userId: string;
  content: { text: string; [key: string]: unknown };
  createdAt: string;
}

export class HybridMemoryManager {
  private readonly filePath: string;

  constructor(agentId: string) {
    const memoryDir = getMemoryDir();
    if (!existsSync(memoryDir)) mkdirSync(memoryDir, { recursive: true });
    this.filePath =
      `${memoryDir}/${agentId.replace(/[^a-z0-9]/g, '').toLowerCase()}.json`;
  }

  async store(memory: Memory): Promise<void> {
    const all = this.load();
    all.push({ ...memory, createdAt: new Date().toISOString() });
    writeFileSync(this.filePath, JSON.stringify(all.slice(-1000), null, 2));
  }

  getJobHistory(jobId: string): StoredMemory[] {
    return this.load().filter(m =>
      m.content.text.includes(jobId) ||
      (m.content.jobIds as string[] | undefined)?.includes(jobId)
    );
  }

  private load(): StoredMemory[] {
    if (!existsSync(this.filePath)) return [];
    try {
      return JSON.parse(readFileSync(this.filePath, 'utf8')) as StoredMemory[];
    } catch { return []; }
  }
}

export async function persistMemory(
  runtime: IElizaRuntime,
  memory: Memory
): Promise<void> {
  try {
    await runtime.getMemoryManager().createMemory(memory);
  } catch {
    await new HybridMemoryManager(runtime.agentId).store(memory);
  }
}