/**
 * JSON Actor Adapter
 */

import type { ActorPort, OrganizationPort } from "../../../ports/actors";
import type {
  ActorRecord,
  ActorStateRecord,
  OrganizationRecord,
  OrganizationStateRecord,
} from "../../../types";
import type { JsonIdGenerator } from "../id-generator";
import type { JsonStorageState } from "../types";

export class JsonActorAdapter implements ActorPort {
  constructor(
    private state: JsonStorageState,
    _idGen: JsonIdGenerator,
    private onChange: () => void,
  ) {}

  async getActor(id: string): Promise<ActorRecord | null> {
    return this.state.actors[id] ?? null;
  }

  async getActors(limit?: number): Promise<ActorRecord[]> {
    const actors = Object.values(this.state.actors);
    return limit ? actors.slice(0, limit) : actors;
  }

  async getActorsByTier(tier: string): Promise<ActorRecord[]> {
    return Object.values(this.state.actors).filter((a) => a.tier === tier);
  }

  async getActorState(id: string): Promise<ActorStateRecord | null> {
    return this.state.actorStates[id] ?? null;
  }

  async getAllActorStates(): Promise<ActorStateRecord[]> {
    return Object.values(this.state.actorStates);
  }

  async upsertActorState(
    state: Partial<ActorStateRecord> & { id: string },
  ): Promise<ActorStateRecord> {
    const existing = this.state.actorStates[state.id];
    const now = new Date();

    const updated: ActorStateRecord = {
      id: state.id,
      tradingBalance:
        state.tradingBalance ?? existing?.tradingBalance ?? "10000",
      reputationPoints:
        state.reputationPoints ?? existing?.reputationPoints ?? 10000,
      hasPool: state.hasPool ?? existing?.hasPool ?? false,
      updatedAt: now,
    };

    this.state.actorStates[state.id] = updated;
    this.onChange();
    return updated;
  }

  async updateActorBalance(id: string, balance: number): Promise<void> {
    const existing = this.state.actorStates[id];
    if (existing) {
      existing.tradingBalance = String(balance);
      existing.updatedAt = new Date();
      this.onChange();
    }
  }

  async updateActorReputation(id: string, points: number): Promise<void> {
    const existing = this.state.actorStates[id];
    if (existing) {
      existing.reputationPoints = points;
      existing.updatedAt = new Date();
      this.onChange();
    }
  }
}

export class JsonOrganizationAdapter implements OrganizationPort {
  constructor(
    private state: JsonStorageState,
    _idGen: JsonIdGenerator,
    private onChange: () => void,
  ) {}

  async getOrganization(id: string): Promise<OrganizationRecord | null> {
    return this.state.organizations[id] ?? null;
  }

  async getOrganizations(): Promise<OrganizationRecord[]> {
    return Object.values(this.state.organizations);
  }

  async getOrganizationsByType(type: string): Promise<OrganizationRecord[]> {
    return Object.values(this.state.organizations).filter(
      (o) => o.type === type,
    );
  }

  async getOrganizationByTicker(
    ticker: string,
  ): Promise<OrganizationRecord | null> {
    const upperTicker = ticker.toUpperCase();
    return (
      Object.values(this.state.organizations).find(
        (o) => o.ticker?.toUpperCase() === upperTicker,
      ) ?? null
    );
  }

  async getOrganizationState(
    id: string,
  ): Promise<OrganizationStateRecord | null> {
    return this.state.organizationStates[id] ?? null;
  }

  async getAllOrganizationStates(): Promise<OrganizationStateRecord[]> {
    return Object.values(this.state.organizationStates);
  }

  async upsertOrganizationState(
    id: string,
    currentPrice: number | null,
  ): Promise<OrganizationStateRecord> {
    const now = new Date();
    const state: OrganizationStateRecord = {
      id,
      currentPrice,
      updatedAt: now,
    };

    this.state.organizationStates[id] = state;
    this.onChange();
    return state;
  }

  async updateOrganizationPrice(id: string, price: number): Promise<void> {
    await this.upsertOrganizationState(id, price);
  }
}
