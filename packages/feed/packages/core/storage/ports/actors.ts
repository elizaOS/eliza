/**
 * Actor Storage Port
 *
 * Defines the interface for actor data access.
 * Actors are NPCs that participate in the game world.
 */

import type {
  ActorRecord,
  ActorStateRecord,
  OrganizationRecord,
  OrganizationStateRecord,
} from "../types";

export interface ActorPort {
  // Actor Operations
  getActor(id: string): Promise<ActorRecord | null>;
  getActors(limit?: number): Promise<ActorRecord[]>;
  getActorsByTier(tier: string): Promise<ActorRecord[]>;

  // Actor State Operations (dynamic data)
  getActorState(id: string): Promise<ActorStateRecord | null>;
  getAllActorStates(): Promise<ActorStateRecord[]>;
  upsertActorState(
    state: Partial<ActorStateRecord> & { id: string },
  ): Promise<ActorStateRecord>;
  updateActorBalance(id: string, balance: number): Promise<void>;
  updateActorReputation(id: string, points: number): Promise<void>;
}

export interface OrganizationPort {
  // Organization Operations
  getOrganization(id: string): Promise<OrganizationRecord | null>;
  getOrganizations(): Promise<OrganizationRecord[]>;
  getOrganizationsByType(type: string): Promise<OrganizationRecord[]>;
  getOrganizationByTicker(ticker: string): Promise<OrganizationRecord | null>;

  // Organization State Operations (dynamic data)
  getOrganizationState(id: string): Promise<OrganizationStateRecord | null>;
  getAllOrganizationStates(): Promise<OrganizationStateRecord[]>;
  upsertOrganizationState(
    id: string,
    currentPrice: number | null,
  ): Promise<OrganizationStateRecord>;
  updateOrganizationPrice(id: string, price: number): Promise<void>;
}
