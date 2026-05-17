import type {
  IdentityLinkRow,
  IdentityLinksRepository,
} from "../../db/repositories/identity-links";
import type { IdentityLinkSource } from "../../db/schemas/identity-links";
import { logger } from "../utils/logger";

export type { IdentityLinkRow } from "../../db/repositories/identity-links";

export interface LinkIdentitiesInput {
  organizationId: string;
  userId?: string | null;
  leftEntityId: string;
  rightEntityId: string;
  provider?: string | null;
  source?: IdentityLinkSource;
}

export interface UnlinkIdentitiesInput {
  leftEntityId: string;
  rightEntityId: string;
  provider?: string | null;
}

export interface IdentityLinkStore {
  link(input: LinkIdentitiesInput): Promise<IdentityLinkRow>;
  unlink(input: UnlinkIdentitiesInput): Promise<number>;
  areEntitiesLinked(leftEntityId: string, rightEntityId: string): Promise<boolean>;
  listLinkedIdentities(entityId: string): Promise<IdentityLinkRow[]>;
}

interface IdentityLinkStoreDeps {
  repository: IdentityLinksRepository;
}

function normalizeEntityId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("entity id must be a non-empty string");
  }
  return trimmed;
}

class IdentityLinkStoreImpl implements IdentityLinkStore {
  private readonly repository: IdentityLinksRepository;

  constructor(deps: IdentityLinkStoreDeps) {
    this.repository = deps.repository;
  }

  async link(input: LinkIdentitiesInput): Promise<IdentityLinkRow> {
    if (!input.organizationId) {
      throw new Error("organizationId is required");
    }
    const left = normalizeEntityId(input.leftEntityId);
    const right = normalizeEntityId(input.rightEntityId);
    if (left === right) {
      throw new Error("Cannot link an entity to itself");
    }

    const row = await this.repository.link({
      organizationId: input.organizationId,
      userId: input.userId ?? null,
      leftEntityId: left,
      rightEntityId: right,
      provider: input.provider ?? null,
      source: input.source ?? "manual",
    });

    logger.info("[IdentityLinkStore] Linked identities", {
      organizationId: input.organizationId,
      leftEntityId: left,
      rightEntityId: right,
      provider: input.provider ?? null,
      source: input.source ?? "manual",
    });

    return row;
  }

  async unlink(input: UnlinkIdentitiesInput): Promise<number> {
    const left = normalizeEntityId(input.leftEntityId);
    const right = normalizeEntityId(input.rightEntityId);

    const removed = await this.repository.unlink({
      leftEntityId: left,
      rightEntityId: right,
      provider: input.provider ?? null,
    });

    if (removed > 0) {
      logger.info("[IdentityLinkStore] Unlinked identities", {
        leftEntityId: left,
        rightEntityId: right,
        provider: input.provider ?? null,
        removed,
      });
    }

    return removed;
  }

  async areEntitiesLinked(leftEntityId: string, rightEntityId: string): Promise<boolean> {
    const left = leftEntityId.trim();
    const right = rightEntityId.trim();
    if (!left || !right) return false;
    if (left === right) return true;
    return this.repository.areEntitiesLinked(left, right);
  }

  async listLinkedIdentities(entityId: string): Promise<IdentityLinkRow[]> {
    const id = entityId.trim();
    if (!id) return [];
    return this.repository.listLinkedIdentities(id);
  }
}

export function createIdentityLinkStore(deps: IdentityLinkStoreDeps): IdentityLinkStore {
  return new IdentityLinkStoreImpl(deps);
}
