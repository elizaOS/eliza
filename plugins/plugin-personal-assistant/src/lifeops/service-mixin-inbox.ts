import type {
  GetLifeOpsInboxRequest,
  LifeOpsInbox,
  LifeOpsInboxMessage,
} from "@elizaos/shared";
import {
  type InboxDeps,
  InboxDomain,
  type LifeOpsInboxService,
} from "./domains/inbox-service.js";
import type {
  Constructor,
  LifeOpsServiceBase,
  MixinClass,
} from "./service-mixin-core.js";

export type { LifeOpsInboxService } from "./domains/inbox-service.js";
export {
  buildInbox,
  buildInboxFromMessages,
  fetchInbox,
  type InboxChatType,
  normalizeInboxChannel,
  type ResolvedInboxRequest,
  resolveInboxRequest,
  toInboxMessage,
  toInboxMessages,
} from "./domains/inbox-service.js";

type InboxMixinDependencies = LifeOpsServiceBase & InboxDeps;

/** @internal */
export function withInbox<TBase extends Constructor<LifeOpsServiceBase>>(
  Base: TBase,
): MixinClass<TBase, LifeOpsInboxService> {
  const InboxBase = Base as unknown as Constructor<InboxMixinDependencies>;

  class LifeOpsInboxServiceMixin extends InboxBase {
    // `this` (a LifeOpsServiceBase subclass) satisfies LifeOpsContext.
    // Public (not private) to avoid TS4094 on the re-exported mixin class.
    readonly inboxDomain = new InboxDomain(this, {
      getGoogleConnectorStatus: (...args) =>
        (this as unknown as InboxDeps).getGoogleConnectorStatus(...args),
      getGmailTriage: (...args) =>
        (this as unknown as InboxDeps).getGmailTriage(...args),
      getXConnectorStatus: (...args) =>
        (this as unknown as InboxDeps).getXConnectorStatus(...args),
      syncXDms: (...args) => (this as unknown as InboxDeps).syncXDms(...args),
      getXDms: (...args) => (this as unknown as InboxDeps).getXDms(...args),
    });

    getInbox(request: GetLifeOpsInboxRequest = {}): Promise<LifeOpsInbox> {
      return this.inboxDomain.getInbox(request);
    }

    markInboxEntryRead(inboxEntryId: string): Promise<LifeOpsInboxMessage> {
      return this.inboxDomain.markInboxEntryRead(inboxEntryId);
    }
  }

  return LifeOpsInboxServiceMixin as unknown as MixinClass<
    TBase,
    LifeOpsInboxService
  >;
}
