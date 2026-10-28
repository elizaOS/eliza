/** Shared two-way calendar reconciliation. Host ports own storage and provider I/O.
 * Opaque phone/browser revisions and numeric SQL revisions use the same state machine. */
export type LinkedCalendarState =
  | "clean"
  | "dirty"
  | "conflicted"
  | "quarantined"
  | "paused"
  | "local_only";

export type LinkedCalendarOperation = "create" | "update" | "delete";

export interface LinkedCalendarEventRecord<
  Revision extends string | number = number,
> {
  id: string;
  agentId: string;
  localEventId: string;
  connectorAccountId: string;
  providerCalendarId: string;
  providerEventId: string | null;
  providerEtag: string | null;
  localRevision: Revision;
  lastCommonSemanticHash: string | null;
  state: LinkedCalendarState;
  pendingOperation: LinkedCalendarOperation | null;
  idempotencyKey: string;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LinkedCalendarSemanticEvent {
  title: string;
  description: string;
  location: string;
  startAt: string;
  endAt: string;
  timeZone: string | null;
  isAllDay: boolean;
  attendees: ReadonlyArray<{ email: string; optional?: boolean }>;
  recurrence?: readonly string[];
  deleted?: boolean;
}

export interface LinkedCalendarLocalSnapshot<
  Revision extends string | number = number,
> {
  eventId: string;
  revision: Revision;
  event: LinkedCalendarSemanticEvent;
}

export interface LinkedCalendarProviderSnapshot {
  eventId: string;
  etag: string | null;
  event: LinkedCalendarSemanticEvent;
}

export interface LinkedCalendarProviderPort<
  Revision extends string | number = number,
> {
  get(
    record: LinkedCalendarEventRecord<Revision>,
  ): Promise<LinkedCalendarProviderSnapshot | null>;
  create(
    record: LinkedCalendarEventRecord<Revision>,
    event: LinkedCalendarSemanticEvent,
  ): Promise<LinkedCalendarProviderSnapshot>;
  update(
    record: LinkedCalendarEventRecord<Revision>,
    event: LinkedCalendarSemanticEvent,
  ): Promise<LinkedCalendarProviderSnapshot>;
  delete(record: LinkedCalendarEventRecord<Revision>): Promise<void>;
}

export interface LinkedCalendarLocalPort<
  Revision extends string | number = number,
> {
  get(eventId: string): Promise<LinkedCalendarLocalSnapshot<Revision> | null>;
  applyProviderEvent(
    eventId: string,
    event: LinkedCalendarSemanticEvent,
    expectedRevision: Revision,
  ): Promise<LinkedCalendarLocalSnapshot<Revision>>;
  delete(eventId: string, expectedRevision: Revision): Promise<void>;
}

export interface LinkedCalendarCheckpointStore<
  Revision extends string | number = number,
> {
  save(
    record: LinkedCalendarEventRecord<Revision>,
    patch: Partial<
      Omit<
        LinkedCalendarEventRecord<Revision>,
        "id" | "agentId" | "localEventId" | "createdAt"
      >
    >,
    now?: Date,
  ): Promise<LinkedCalendarEventRecord<Revision>>;
}

function googleMutationFailure(error: unknown): {
  outcome: "not_accepted" | "precondition_failed";
  code: string;
  message: string;
} | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as {
    outcome?: unknown;
    code?: unknown;
    message?: unknown;
  };
  if (
    candidate.outcome !== "not_accepted" &&
    candidate.outcome !== "precondition_failed"
  ) {
    return null;
  }
  return {
    outcome: candidate.outcome,
    code:
      typeof candidate.code === "string"
        ? candidate.code
        : "GOOGLE_CALENDAR_MUTATION_REJECTED",
    message:
      typeof candidate.message === "string"
        ? candidate.message
        : "Google Calendar rejected the mutation.",
  };
}

export function linkedCalendarSemanticText(
  event: LinkedCalendarSemanticEvent,
): string {
  const normalized = {
    title: event.title.trim(),
    description: event.description.trim(),
    location: event.location.trim(),
    startAt: event.startAt,
    endAt: event.endAt,
    timeZone: event.isAllDay ? null : event.timeZone,
    // Retain timed-event checkpoints; all-day semantics need a distinct hash.
    ...(event.isAllDay ? { isAllDay: true } : {}),
    attendees: [...event.attendees]
      .map((attendee) => ({
        email: attendee.email.trim().toLowerCase(),
        optional: attendee.optional === true,
      }))
      .sort((left, right) =>
        left.email < right.email ? -1 : left.email > right.email ? 1 : 0,
      ),
    deleted: event.deleted === true,
    ...(event.recurrence?.length
      ? { recurrence: [...event.recurrence].map((line) => line.trim()).sort() }
      : {}),
  };
  return JSON.stringify(normalized);
}

export async function linkedCalendarSemanticDigest(
  event: LinkedCalendarSemanticEvent,
): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(linkedCalendarSemanticText(event)),
  );
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export type LinkedCalendarReconcileOutcome =
  | "clean"
  | "dirty"
  | "pushed"
  | "pulled"
  | "conflicted"
  | "quarantined"
  | "paused";

export class LinkedCalendarReconciler<
  Revision extends string | number = number,
> {
  constructor(
    private readonly repository: LinkedCalendarCheckpointStore<Revision>,
    private readonly local: LinkedCalendarLocalPort<Revision>,
    private readonly provider: LinkedCalendarProviderPort<Revision>,
    private readonly onProviderMutation?: () => void,
  ) {}

  async reconcile(
    record: LinkedCalendarEventRecord<Revision>,
  ): Promise<LinkedCalendarReconcileOutcome> {
    if (record.state === "paused" || record.state === "local_only")
      return "paused";
    if (record.state === "conflicted") return "conflicted";
    if (record.state === "quarantined") return "quarantined";

    const local = await this.local.get(record.localEventId);
    if (!local) {
      if (record.pendingOperation === "delete") {
        const provider = await this.provider.get(record);
        try {
          if (provider) {
            this.onProviderMutation?.();
            await this.provider.delete(record);
          }
        } catch (error) {
          const mutationFailure = googleMutationFailure(error);
          if (mutationFailure?.outcome === "not_accepted") {
            await this.repository.save(record, {
              state: "dirty",
              pendingOperation: "delete",
              lastErrorCode: mutationFailure.code,
              lastErrorMessage: mutationFailure.message,
            });
            return "dirty";
          }
          if (mutationFailure?.outcome === "precondition_failed") {
            await this.repository.save(record, {
              state: "conflicted",
              pendingOperation: null,
              lastErrorCode: mutationFailure.code,
              lastErrorMessage: mutationFailure.message,
            });
            return "conflicted";
          }
          return this.quarantine(
            record,
            "LINKED_CALENDAR_UNKNOWN_PROVIDER_OUTCOME",
            error instanceof Error ? error.message : String(error),
          );
        }
        await this.repository.save(record, {
          state: "paused",
          pendingOperation: null,
          providerEtag: null,
          lastErrorCode: "LINKED_CALENDAR_LOCAL_EVENT_DELETED",
          lastErrorMessage:
            "The Eliza event was deleted and the linked Google event was removed.",
        });
        return "pushed";
      }
      return this.quarantine(
        record,
        "LINKED_LOCAL_EVENT_MISSING",
        "The linked Eliza event no longer exists.",
      );
    }
    const provider = await this.provider.get(record);
    const localHash = await linkedCalendarSemanticDigest(local.event);
    const providerHash = provider
      ? await linkedCalendarSemanticDigest(provider.event)
      : null;
    const localChanged = record.lastCommonSemanticHash !== localHash;
    const providerChanged =
      providerHash !== null && record.lastCommonSemanticHash !== providerHash;

    if (
      provider &&
      localChanged &&
      providerChanged &&
      localHash !== providerHash
    ) {
      await this.repository.save(record, {
        state: "conflicted",
        pendingOperation: null,
        lastErrorCode: "LINKED_CALENDAR_CONCURRENT_EDIT",
        lastErrorMessage:
          "Eliza and Google changed since their last common version.",
      });
      return "conflicted";
    }

    if (provider && providerChanged && !localChanged) {
      if (provider.event.deleted) {
        try {
          await this.local.delete(local.eventId, local.revision);
        } catch (error) {
          return this.quarantine(
            record,
            "LINKED_CALENDAR_LOCAL_DELETE_CAS_REJECTED",
            error instanceof Error ? error.message : String(error),
          );
        }
        await this.repository.save(record, {
          state: "paused",
          pendingOperation: null,
          providerEventId: provider.eventId,
          providerEtag: provider.etag,
          lastCommonSemanticHash: await linkedCalendarSemanticDigest(
            provider.event,
          ),
          lastErrorCode: "LINKED_CALENDAR_PROVIDER_EVENT_DELETED",
          lastErrorMessage:
            "Google deleted the linked event; the Eliza event was removed and the retained link was paused.",
        });
        return "pulled";
      }
      let applied: LinkedCalendarLocalSnapshot<Revision>;
      try {
        applied = await this.local.applyProviderEvent(
          local.eventId,
          provider.event,
          local.revision,
        );
      } catch (error) {
        return this.quarantine(
          record,
          "LINKED_CALENDAR_LOCAL_CAS_REJECTED",
          error instanceof Error ? error.message : String(error),
        );
      }
      await this.repository.save(record, {
        localRevision: applied.revision,
        providerEventId: provider.eventId,
        providerEtag: provider.etag,
        lastCommonSemanticHash: providerHash,
        state: "clean",
        pendingOperation: null,
        lastErrorCode: null,
        lastErrorMessage: null,
      });
      return "pulled";
    }

    if (!provider && record.providerEventId && !localChanged) {
      try {
        await this.local.delete(local.eventId, local.revision);
      } catch (error) {
        return this.quarantine(
          record,
          "LINKED_CALENDAR_LOCAL_DELETE_CAS_REJECTED",
          error instanceof Error ? error.message : String(error),
        );
      }
      await this.repository.save(record, {
        state: "paused",
        pendingOperation: null,
        providerEtag: null,
        lastErrorCode: "LINKED_CALENDAR_PROVIDER_EVENT_DELETED",
        lastErrorMessage:
          "Google deleted the linked event; the Eliza event was removed and the retained link was paused.",
      });
      return "pulled";
    }

    if (!provider || (localChanged && localHash !== providerHash)) {
      return this.push(record, local, provider);
    }

    if (
      record.state !== "clean" ||
      record.lastCommonSemanticHash !== localHash ||
      record.localRevision !== local.revision ||
      record.providerEtag !== provider.etag
    ) {
      await this.repository.save(record, {
        localRevision: local.revision,
        providerEventId: provider.eventId,
        providerEtag: provider.etag,
        lastCommonSemanticHash: localHash,
        state: "clean",
        pendingOperation: null,
        lastErrorCode: null,
        lastErrorMessage: null,
      });
    }
    return "clean";
  }

  /**
   * Checkpoints a provider-confirmed outcome without replaying a mutation.
   * The caller retains the dispatch barrier until this returns true. An absent
   * create or unchanged update ETag cannot prove a timed-out request finished.
   */
  async recoverDispatch(
    record: LinkedCalendarEventRecord<Revision>,
  ): Promise<boolean> {
    const local = await this.local.get(record.localEventId);
    const provider = await this.provider.get(record);
    if (record.pendingOperation === "delete") {
      if (
        !record.providerEventId ||
        provider ||
        (local && !local.event.deleted)
      )
        return false;
      await this.repository.save(record, {
        state: "paused",
        pendingOperation: null,
        providerEtag: null,
        lastErrorCode: "LINKED_CALENDAR_DELETE_RECOVERED",
        lastErrorMessage: "Google confirmed the pending event deletion.",
      });
      return true;
    }
    if (!local || !provider || local.event.deleted || provider.event.deleted)
      return false;
    if (
      (await linkedCalendarSemanticDigest(local.event)) !==
      (await linkedCalendarSemanticDigest(provider.event))
    )
      return false;
    if (
      record.pendingOperation === "update" &&
      (!record.providerEtag ||
        !provider.etag ||
        record.providerEtag === provider.etag)
    )
      return false;
    await this.repository.save(record, {
      providerEventId: provider.eventId,
      providerEtag: provider.etag,
      localRevision: local.revision,
      lastCommonSemanticHash: await linkedCalendarSemanticDigest(
        provider.event,
      ),
      state: "clean",
      pendingOperation: null,
      lastErrorCode: null,
      lastErrorMessage: null,
    });
    return true;
  }

  async resolveConflict(
    record: LinkedCalendarEventRecord<Revision>,
    strategy: "keep_eliza" | "keep_google",
  ): Promise<LinkedCalendarReconcileOutcome> {
    if (record.state !== "conflicted") return this.reconcile(record);
    const local = await this.local.get(record.localEventId);
    if (!local) {
      return this.quarantine(
        record,
        "LINKED_LOCAL_EVENT_MISSING",
        "The linked Eliza event no longer exists.",
      );
    }
    const provider = await this.provider.get(record);
    if (!provider) {
      return this.quarantine(
        record,
        "LINKED_PROVIDER_EVENT_MISSING",
        "The linked Google event no longer exists.",
      );
    }
    if (strategy === "keep_google") {
      let applied: LinkedCalendarLocalSnapshot<Revision>;
      try {
        applied = await this.local.applyProviderEvent(
          local.eventId,
          provider.event,
          local.revision,
        );
      } catch (error) {
        return this.quarantine(
          record,
          "LINKED_CALENDAR_LOCAL_CAS_REJECTED",
          error instanceof Error ? error.message : String(error),
        );
      }
      await this.repository.save(record, {
        localRevision: applied.revision,
        providerEventId: provider.eventId,
        providerEtag: provider.etag,
        lastCommonSemanticHash: await linkedCalendarSemanticDigest(
          provider.event,
        ),
        state: "clean",
        pendingOperation: null,
        lastErrorCode: null,
        lastErrorMessage: null,
      });
      return "pulled";
    }
    if (!provider.etag)
      return this.quarantine(
        record,
        "LINKED_PROVIDER_REVISION_MISSING",
        "The provider did not supply an exact revision. No write was attempted.",
      );
    const dirty = await this.repository.save(record, {
      state: "dirty",
      pendingOperation: "update",
      providerEventId: provider.eventId,
      providerEtag: provider.etag,
      localRevision: local.revision,
      lastCommonSemanticHash: await linkedCalendarSemanticDigest(
        provider.event,
      ),
      lastErrorCode: null,
      lastErrorMessage: null,
    });
    return this.reconcile(dirty);
  }

  private async push(
    record: LinkedCalendarEventRecord<Revision>,
    local: LinkedCalendarLocalSnapshot<Revision>,
    provider: LinkedCalendarProviderSnapshot | null,
  ): Promise<LinkedCalendarReconcileOutcome> {
    const operation: LinkedCalendarOperation = local.event.deleted
      ? "delete"
      : provider
        ? "update"
        : "create";
    let pending = record;
    if (record.pendingOperation !== operation || record.state !== "dirty") {
      pending = await this.repository.save(record, {
        state: "dirty",
        pendingOperation: operation,
        localRevision: local.revision,
      });
    }
    try {
      if (operation === "delete") {
        if (provider) {
          this.onProviderMutation?.();
          await this.provider.delete(pending);
        }
        await this.repository.save(pending, {
          providerEventId: provider?.eventId ?? pending.providerEventId,
          providerEtag: null,
          lastCommonSemanticHash: await linkedCalendarSemanticDigest(
            local.event,
          ),
          state: "clean",
          pendingOperation: null,
          lastErrorCode: null,
          lastErrorMessage: null,
        });
      } else {
        this.onProviderMutation?.();
        const written =
          operation === "create"
            ? await this.provider.create(pending, local.event)
            : await this.provider.update(pending, local.event);
        await this.repository.save(pending, {
          providerEventId: written.eventId,
          providerEtag: written.etag,
          localRevision: local.revision,
          lastCommonSemanticHash: await linkedCalendarSemanticDigest(
            written.event,
          ),
          state: "clean",
          pendingOperation: null,
          lastErrorCode: null,
          lastErrorMessage: null,
        });
      }
      return "pushed";
    } catch (error) {
      const mutationFailure = googleMutationFailure(error);
      if (mutationFailure) {
        const state: LinkedCalendarState =
          mutationFailure.outcome === "precondition_failed"
            ? "conflicted"
            : "dirty";
        await this.repository.save(pending, {
          state,
          pendingOperation: state === "dirty" ? operation : null,
          lastErrorCode: mutationFailure.code,
          lastErrorMessage: mutationFailure.message,
        });
        return state === "conflicted" ? "conflicted" : "dirty";
      }
      return this.quarantine(
        pending,
        "LINKED_CALENDAR_UNKNOWN_PROVIDER_OUTCOME",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async quarantine(
    record: LinkedCalendarEventRecord<Revision>,
    code: string,
    message: string,
  ): Promise<"quarantined"> {
    await this.repository.save(record, {
      state: "quarantined",
      lastErrorCode: code,
      lastErrorMessage: message,
    });
    return "quarantined";
  }
}
