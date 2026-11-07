/**
 * Renderer half of the background new-mail check (decision P-14). The native half is
 * `MailBackgroundDelivery` in plugin-native-notifications: periodic constrained checks of the
 * Cloud owner Gmail history route, durable at-most-once content-free notices and one-use taps.
 *
 * The host registers its own native bridge under its installed plugin name and passes it here,
 * with whether it runs natively and how it announces a status change. Nothing here reads mail:
 * a tap only names the grant, owner and message the renderer must revalidate before it opens
 * the Inbox list or, for an explicit Ask, reads that one message.
 *
 * Background admission is bound to the signed-in Cloud credential and owner, not to the agent's
 * inference provider: the check only reads Cloud Gmail routes with the Cloud key.
 */

export type MailBackgroundState =
  | "web-unavailable"
  | "unavailable"
  | "disabled"
  | "waiting"
  | "watching-new-mail"
  | "catching-up"
  | "history-expired"
  | "unsupported"
  | "retrying"
  | "grant-unavailable"
  | "capacity-reached";

export interface MailBackgroundStatus {
  status: MailBackgroundState | string;
  lastSyncAt?: number;
  incompleteCatchup?: boolean;
  uncertainNotices?: number;
  deniedNotices?: number;
  notificationsAllowed?: boolean;
  grantId?: string;
}

/** A captured notice tap. Native has verified the owner and grant again before returning it. */
export interface MailNoticeTap {
  token: string;
  grantId: string;
  credentialId: string;
  userId: string;
  generation: string;
  /** True for the explicit Ask action; false or absent for an ordinary tap. */
  question?: boolean;
  messageId?: string;
  threadId?: string;
}

/** The selection the foreground UI shows: native verifies this owner and grant with Cloud itself. */
export interface MailBackgroundSelection {
  credentialId: string;
  grantId: string;
  userId: string;
  organizationId: string;
}

/** The host's native bridge (Capacitor or otherwise), registered under the host's plugin name. */
export interface MailBackgroundNative {
  configure(input: MailBackgroundSelection): Promise<MailBackgroundStatus>;
  withdraw(input?: { grantId?: string }): Promise<void>;
  status(): Promise<MailBackgroundStatus>;
  pending(): Promise<Partial<MailNoticeTap>>;
  releaseQuestion(input: { token: string }): Promise<void>;
  consume(input: { token: string }): Promise<void>;
  notificationSettings(): Promise<void>;
  addListener(
    name: "pendingMail",
    handler: () => void,
  ): Promise<{ remove(): Promise<void> }>;
}

export interface MailBackgroundOptions {
  /** The native bridge; resolved lazily so a host can register it on first use. */
  native: () => MailBackgroundNative;
  /** False on the web and other hosts without the native module: every call is a safe no-op. */
  available: boolean;
  /** Announces a configuration change (for example a window event the settings panel listens to). */
  changed?: () => void;
}

export interface MailBackground {
  /** Enables background checks for the selection, or withdraws them when no grant is selected. */
  configure(selection: MailBackgroundSelection | null): Promise<void>;
  withdraw(grantId?: string): Promise<void>;
  /**
   * Retires native state for a grant around an explicit revoke without letting local bookkeeping
   * block it. Starts immediately; `settled` retries once after the revoke and never rejects
   * (native sync and taps re-verify the grant and fail closed).
   */
  retire(grantId: string): { settled(): Promise<void> };
  status(): Promise<MailBackgroundStatus>;
  notificationSettings(): Promise<void>;
  pending(): Promise<MailNoticeTap | null>;
  consume(token: string): Promise<void>;
  releaseQuestion(token: string): Promise<void>;
  /** A missing native bridge (older shell, test fixture) means no taps, never an unhandled rejection. */
  onNotice(handler: () => void): Promise<{ remove(): Promise<void> }>;
}

const noListener = { remove: async () => {} };

/** A pending tap only when every identity field is present; anything else is no tap. */
export function readMailNoticeTap(
  value: Partial<MailNoticeTap> | null | undefined,
): MailNoticeTap | null {
  if (!value) return null;
  const fields = [
    value.token,
    value.grantId,
    value.credentialId,
    value.userId,
    value.generation,
  ];
  if (!fields.every((field) => typeof field === "string" && field.length > 0))
    return null;
  return value as MailNoticeTap;
}

export function createMailBackground(
  options: MailBackgroundOptions,
): MailBackground {
  const changed = () => {
    try {
      options.changed?.();
    } catch {
      /* A listener failure never blocks the native change. */
    }
  };
  const withdraw = async (grantId?: string) => {
    if (!options.available) return;
    await options.native().withdraw(grantId ? { grantId } : undefined);
    changed();
  };
  return {
    async configure(selection) {
      if (!options.available) return;
      try {
        if (selection?.grantId) await options.native().configure(selection);
        else await options.native().withdraw();
      } finally {
        changed();
      }
    },
    withdraw,
    retire(grantId) {
      const first = withdraw(grantId).then(
        () => true,
        () => false,
      );
      return {
        async settled() {
          if (!(await first)) await withdraw(grantId).catch(() => {});
        },
      };
    },
    async status() {
      if (!options.available) return { status: "web-unavailable" };
      try {
        return await options.native().status();
      } catch {
        return { status: "unavailable" };
      }
    },
    notificationSettings: () =>
      options.available
        ? options.native().notificationSettings()
        : Promise.resolve(),
    async pending() {
      if (!options.available) return null;
      return readMailNoticeTap(await options.native().pending());
    },
    async consume(token) {
      if (options.available) await options.native().consume({ token });
    },
    async releaseQuestion(token) {
      if (options.available) await options.native().releaseQuestion({ token });
    },
    onNotice(handler) {
      if (!options.available) return Promise.resolve(noListener);
      try {
        return Promise.resolve(
          options.native().addListener("pendingMail", handler),
        ).catch(() => noListener);
      } catch {
        return Promise.resolve(noListener);
      }
    },
  };
}

/** Owner-facing status text for Settings. Never claims a check that did not happen. */
export function mailBackgroundMessage(
  value: MailBackgroundStatus,
  locale?: string,
): string {
  const checked = value.lastSyncAt
    ? ` Last successful check: ${new Date(value.lastSyncAt).toLocaleString(locale)}.`
    : " No successful background check yet.";
  const suffix = `${checked} Android may delay checks in Doze or battery saver. Open Inbox to check current mail.`;
  switch (value.status) {
    case "web-unavailable":
      return "Background Gmail notices are available in the Android app.";
    case "disabled":
      return "Open Inbox and select a connected Gmail account to enable background checks.";
    case "unsupported":
      return `Background Gmail is unavailable on this server. Open Inbox to check mail.${checked}`;
    case "grant-unavailable":
      return "Gmail background checks need the matching Cloud sign-in and Google read access. Recheck the account in Inbox.";
    case "capacity-reached":
      return "Gmail notice history is full. Background catch-up is incomplete; open Inbox to review current mail.";
    case "retrying":
    case "unavailable":
      return `Gmail background checks are unavailable or waiting to retry. Saved progress is retained.${suffix}`;
  }
  const phase =
    value.status === "history-expired"
      ? "Gmail history expired. Earlier missed messages were not reconciled."
      : value.status === "catching-up"
        ? "Gmail changes are still being reconciled."
        : "Watching for new unread Inbox messages. Earlier mailbox changes were not backfilled.";
  return (
    phase +
    (value.notificationsAllowed === false
      ? " Android notifications or this channel are disabled."
      : "") +
    (value.uncertainNotices
      ? " Some notification attempts have unknown outcomes and will not be repeated."
      : "") +
    suffix
  );
}
