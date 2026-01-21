/**
 * Entity Types for @polyagent/agents
 *
 * Types for entities that can be mentioned in messages
 */

/**
 * Company/Organization entity
 */
export interface CompanyEntity {
  id: string;
  name: string;
  ticker?: string;
  description?: string;
  bio?: string;
  currentPrice?: number | string;
  priceChangePercentage?: number;
  volume24h?: number | string;
  imageUrl?: string;
}

/**
 * User entity
 */
export interface UserEntity {
  id: string;
  username: string;
  displayName?: string | null;
  bio?: string | null;
  isAgent?: boolean;
  reputationPoints?: number | null;
}

/**
 * Actor/Character entity
 */
export interface ActorEntity {
  id: string;
  name: string;
  description?: string | null;
  bio?: string | null;
  category?: string | null;
  role?: string | null;
  profileImageUrl?: string | null;
}

/**
 * Entity mention result
 */
export interface EntityMention {
  type: "company" | "user" | "actor";
  data: CompanyEntity | UserEntity | ActorEntity;
}

/**
 * Type guard for company entity
 */
export function isCompanyEntity(
  entity: CompanyEntity | UserEntity | ActorEntity,
): entity is CompanyEntity {
  return "ticker" in entity || "currentPrice" in entity;
}

/**
 * Type guard for user entity
 */
export function isUserEntity(
  entity: CompanyEntity | UserEntity | ActorEntity,
): entity is UserEntity {
  return "username" in entity && !("ticker" in entity);
}

/**
 * Type guard for actor entity
 */
export function isActorEntity(
  entity: CompanyEntity | UserEntity | ActorEntity,
): entity is ActorEntity {
  return "name" in entity && !("username" in entity) && !("ticker" in entity);
}
