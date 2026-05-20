/**
 * JSON Storage Provider
 *
 * File-based storage implementation for simulation, training, and debugging.
 * Stores all data in JSON files for easy inspection and modification.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ActorPort, OrganizationPort } from '../../ports/actors';
import type { AgentPort } from '../../ports/agents';
import type { GamePort } from '../../ports/game';
import type { MarketPort } from '../../ports/markets';
import type { PostPort } from '../../ports/posts';
import type { QuestionPort } from '../../ports/questions';
import type {
  IStorageProvider,
  StorageMode,
  StorageProviderConfig,
} from '../../ports/storage-provider';
import type { TradingPort } from '../../ports/trading';
import type { UserPort } from '../../ports/users';
import { JsonIdGenerator } from './id-generator';
import { JsonActorAdapter, JsonOrganizationAdapter } from './ports/actors';
import { JsonAgentAdapter } from './ports/agents';
import { JsonGameAdapter } from './ports/game';
import { JsonMarketAdapter } from './ports/markets';
import { JsonPostAdapter } from './ports/posts';
import { JsonQuestionAdapter } from './ports/questions';
import { JsonTradingAdapter } from './ports/trading';
import { JsonUserAdapter } from './ports/users';
import { createEmptyState, type JsonStorageState } from './types';

export class JsonStorageProvider implements IStorageProvider {
  readonly mode: StorageMode = 'json';

  private state: JsonStorageState;
  private basePath: string;
  private idGenerator: JsonIdGenerator;
  private autoSave: boolean;
  private initialized = false;

  readonly actors: ActorPort;
  readonly organizations: OrganizationPort;
  readonly agents: AgentPort;
  readonly game: GamePort;
  readonly markets: MarketPort;
  readonly posts: PostPort;
  readonly questions: QuestionPort;
  readonly trading: TradingPort;
  readonly users: UserPort;

  constructor(config: StorageProviderConfig) {
    this.basePath = config.jsonBasePath ?? './feed-data';
    this.autoSave = config.persistOnChange ?? true;
    this.state = createEmptyState();
    this.idGenerator = new JsonIdGenerator('sim');

    // Initialize adapters with shared state
    this.actors = new JsonActorAdapter(this.state, this.idGenerator, () =>
      this.onStateChange()
    );
    this.organizations = new JsonOrganizationAdapter(
      this.state,
      this.idGenerator,
      () => this.onStateChange()
    );
    this.agents = new JsonAgentAdapter(this.state, this.idGenerator, () =>
      this.onStateChange()
    );
    this.game = new JsonGameAdapter(this.state, this.idGenerator, () =>
      this.onStateChange()
    );
    this.markets = new JsonMarketAdapter(this.state, this.idGenerator, () =>
      this.onStateChange()
    );
    this.posts = new JsonPostAdapter(this.state, this.idGenerator, () =>
      this.onStateChange()
    );
    this.questions = new JsonQuestionAdapter(this.state, this.idGenerator, () =>
      this.onStateChange()
    );
    this.trading = new JsonTradingAdapter(this.state, this.idGenerator, () =>
      this.onStateChange()
    );
    this.users = new JsonUserAdapter(this.state, this.idGenerator, () =>
      this.onStateChange()
    );
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Ensure base directory exists
    if (!existsSync(this.basePath)) {
      mkdirSync(this.basePath, { recursive: true });
    }

    // Try to load existing state
    const statePath = join(this.basePath, 'state.json');
    if (existsSync(statePath)) {
      const data = readFileSync(statePath, 'utf-8');
      const loaded = JSON.parse(data) as JsonStorageState;
      this.mergeState(loaded);
    }

    this.initialized = true;
  }

  async shutdown(): Promise<void> {
    await this.saveSnapshot();
  }

  async isHealthy(): Promise<boolean> {
    return this.initialized;
  }

  async saveSnapshot(): Promise<void> {
    const statePath = join(this.basePath, 'state.json');
    this.state.metadata.updatedAt = new Date().toISOString();

    // Update counters from ID generator
    const counters = this.idGenerator.exportCounters();
    this.state.counters = {
      post: counters.post ?? 0,
      question: counters.question ?? 0,
      market: counters.market ?? 0,
      position: counters.position ?? 0,
      trade: counters.trade ?? 0,
      event: counters.event ?? 0,
      snapshot: counters.snapshot ?? 0,
      log: counters.log ?? 0,
      message: counters.message ?? 0,
      transaction: counters.transaction ?? 0,
    };

    writeFileSync(statePath, JSON.stringify(this.state, null, 2));
  }

  async loadSnapshot(path: string): Promise<void> {
    const data = readFileSync(path, 'utf-8');
    const loaded = JSON.parse(data) as JsonStorageState;
    this.mergeState(loaded);
  }

  async exportToJson(path: string): Promise<void> {
    const exportPath = path.endsWith('.json')
      ? path
      : join(path, 'export.json');
    this.state.metadata.updatedAt = new Date().toISOString();
    writeFileSync(exportPath, JSON.stringify(this.state, null, 2));
  }

  /**
   * Get direct access to the state (for advanced usage/testing).
   */
  getState(): JsonStorageState {
    return this.state;
  }

  /**
   * Replace the entire state (for loading from file).
   */
  setState(state: JsonStorageState): void {
    this.mergeState(state);
  }

  private mergeState(loaded: JsonStorageState): void {
    // Merge loaded state with current state
    this.state = {
      ...this.state,
      ...loaded,
      metadata: {
        ...this.state.metadata,
        ...loaded.metadata,
      },
    };

    // Restore counters
    if (loaded.counters) {
      this.idGenerator.importCounters(loaded.counters);
    }
  }

  private onStateChange(): void {
    if (this.autoSave && this.initialized) {
      // Debounce saves in a real implementation
      void this.saveSnapshot();
    }
  }
}
