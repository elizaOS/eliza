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
  /** Re-reads a row whose save lost a race, so a landed write can still be checkpointed. */
  reload?(
    record: LinkedCalendarEventRecord<Revision>,
  ): Promise<LinkedCalendarEventRecord<Revision> | null>;
}

type LinkedCalendarCheckpointPatch<Revision extends string | number> = Partial<
  Omit<
    LinkedCalendarEventRecord<Revision>,
    "id" | "agentId" | "localEventId" | "createdAt"
  >
>;

function localCasRejected(error: unknown, code: string): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    (error as { code?: unknown }).code === code
  );
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
        let pending = record;
        if (provider) {
          // A fresh ETag only absorbs non-semantic Google changes. After a
          // semantic Google edit the stored ETag makes the delete fail as a
          // conflict instead of removing the owner's edit.
          const unchanged =
            (await linkedCalendarSemanticDigest(provider.event)) ===
            record.lastCommonSemanticHash;
          const providerEtag = unchanged ? provider.etag : record.providerEtag;
          if (!providerEtag && !unchanged) {
            await this.repository.save(record, {
              state: "conflicted",
              pendingOperation: null,
              providerEventId: provider.eventId,
              lastErrorCode: "LINKED_CALENDAR_CONCURRENT_EDIT",
              lastErrorMessage:
                "Eliza deleted the event after Google changed it.",
            });
            return "conflicted";
          }
          pending = await this.repository.save(record, {
            providerEventId: provider.eventId,
            providerEtag,
          });
          try {
            this.onProviderMutation?.();
            await this.provider.delete(pending);
          } catch (error) {
            const mutationFailure = googleMutationFailure(error);
            if (mutationFailure?.outcome === "not_accepted") {
              await this.repository.save(pending, {
                state: "dirty",
                pendingOperation: "delete",
                lastErrorCode: mutationFailure.code,
                lastErrorMessage: mutationFailure.message,
              });
              return "dirty";
            }
            if (mutationFailure?.outcome === "precondition_failed") {
              await this.repository.save(pending, {
                state: "conflicted",
                pendingOperation: null,
                lastErrorCode: mutationFailure.code,
                lastErrorMessage: mutationFailure.message,
              });
              return "conflicted";
            }
            return this.quarantine(
              pending,
              "LINKED_CALENDAR_UNKNOWN_PROVIDER_OUTCOME",
              error instanceof Error ? error.message : String(error),
            );
          }
        }
        await this.checkpointLanded(
          pending,
          {
            providerEventId: pending.providerEventId,
            providerEtag: null,
            lastCommonSemanticHash: pending.lastCommonSemanticHash,
          },
          {
            state: "paused",
            pendingOperation: null,
            lastErrorCode: "LINKED_CALENDAR_LOCAL_EVENT_DELETED",
            lastErrorMessage:
              "The Eliza event was deleted and the linked Google event was removed.",
          },
          pending.localRevision,
          "delete",
          false,
        );
        return "pushed";
      }
      if (!record.providerEventId) {
        const provider = await this.provider.get(record);
        if (!provider) {
          await this.repository.save(record, {
            state: "paused",
            pendingOperation: null,
            lastErrorCode: "LINKED_CALENDAR_LOCAL_EVENT_DELETED",
            lastErrorMessage:
              "The Eliza event was deleted before it reached Google.",
          });
          return "paused";
        }
        record = await this.repository.save(record, {
          providerEventId: provider.eventId,
          providerEtag: provider.etag,
        });
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
    // A pending update is a local change even when the edit reverted to the
    // common version, so a revert is never silently overwritten by Google.
    const localChanged =
      record.lastCommonSemanticHash !== localHash ||
      (record.state === "dirty" && record.pendingOperation === "update");
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
          // A concurrent local edit already marked the row dirty; the next
          // pass sees both sides changed.
          if (
            localCasRejected(error, "LINKED_CALENDAR_LOCAL_DELETE_CAS_REJECTED")
          )
            return "dirty";
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
        if (localCasRejected(error, "LINKED_CALENDAR_LOCAL_CAS_REJECTED"))
          return "dirty";
        return this.quarantine(
          record,
          "LINKED_CALENDAR_LOCAL_CAS_REJECTED",
          error instanceof Error ? error.message : String(error),
        );
      }
      await this.checkpointLanded(
        record,
        {
          providerEventId: provider.eventId,
          providerEtag: provider.etag,
          lastCommonSemanticHash: providerHash,
        },
        {
          localRevision: applied.revision,
          state: "clean",
          pendingOperation: null,
          lastErrorCode: null,
          lastErrorMessage: null,
        },
        record.localRevision,
        record.pendingOperation,
        true,
      );
      return "pulled";
    }

    if (!provider && record.providerEventId && !localChanged) {
      try {
        await this.local.delete(local.eventId, local.revision);
      } catch (error) {
        if (
          localCasRejected(error, "LINKED_CALENDAR_LOCAL_DELETE_CAS_REJECTED")
        )
          return "dirty";
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

    if (
      !provider &&
      record.providerEventId &&
      localChanged &&
      !local.event.deleted
    ) {
      // Re-creating under the old idempotency key could revive or collide
      // with the deleted Google event; the owner chooses instead.
      await this.repository.save(record, {
        state: "conflicted",
        pendingOperation: null,
        lastErrorCode: "LINKED_CALENDAR_PROVIDER_DELETED_LOCAL_EDITED",
        lastErrorMessage:
          "Google deleted the linked event after it was changed in Eliza.",
      });
      return "conflicted";
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
      if (provider.event.deleted) {
        try {
          await this.local.delete(local.eventId, local.revision);
        } catch (error) {
          if (
            localCasRejected(error, "LINKED_CALENDAR_LOCAL_DELETE_CAS_REJECTED")
          )
            return "conflicted";
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
        if (localCasRejected(error, "LINKED_CALENDAR_LOCAL_CAS_REJECTED"))
          return "conflicted";
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
    const localHash = await linkedCalendarSemanticDigest(local.event);
    // A provider here is semantically unchanged since the common version, so
    // its fresh ETag only absorbs non-semantic Google changes. A create's
    // common hash is its own value: if the write lands but its checkpoint is
    // lost, the next pass sees Google unchanged rather than a conflict.
    const pending = await this.repository.save(record, {
      state: "dirty",
      pendingOperation: operation,
      localRevision: local.revision,
      ...(provider
        ? { providerEventId: provider.eventId, providerEtag: provider.etag }
        : {}),
      ...(operation === "create" ? { lastCommonSemanticHash: localHash } : {}),
    });
    let written: LinkedCalendarProviderSnapshot | null = null;
    try {
      if (operation === "delete") {
        if (provider) {
          this.onProviderMutation?.();
          await this.provider.delete(pending);
        }
      } else {
        this.onProviderMutation?.();
        written =
          operation === "create"
            ? await this.provider.create(pending, local.event)
            : await this.provider.update(pending, local.event);
      }
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
    await this.checkpointLanded(
      pending,
      written
        ? {
            providerEventId: written.eventId,
            providerEtag: written.etag,
            lastCommonSemanticHash: await linkedCalendarSemanticDigest(
              written.event,
            ),
          }
        : {
            providerEventId: provider?.eventId ?? pending.providerEventId,
            providerEtag: null,
            lastCommonSemanticHash: localHash,
          },
      {
        localRevision: local.revision,
        state: "clean",
        pendingOperation: null,
        lastErrorCode: null,
        lastErrorMessage: null,
      },
      local.revision,
      operation,
      written !== null,
    );
    return "pushed";
  }

  /**
   * Checkpoints a write that already happened. If a local edit raced the
   * write, the row is reloaded and keeps that newer edit pending while
   * recording the landed provider identity, ETag and common hash, so the next
   * pass pushes the edit instead of the dispatch being held forever.
   */
  private async checkpointLanded(
    pending: LinkedCalendarEventRecord<Revision>,
    landed: Pick<
      LinkedCalendarEventRecord<Revision>,
      "providerEventId" | "providerEtag" | "lastCommonSemanticHash"
    >,
    settled: LinkedCalendarCheckpointPatch<Revision>,
    expectedRevision: Revision,
    expectedOperation: LinkedCalendarOperation | null,
    eventExists: boolean,
  ): Promise<LinkedCalendarEventRecord<Revision>> {
    try {
      return await this.repository.save(pending, { ...landed, ...settled });
    } catch (error) {
      if (!this.repository.reload) throw error;
      let failure = error;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const fresh = await this.repository.reload(pending);
        if (!fresh) throw failure;
        const unchanged =
          fresh.localRevision === expectedRevision &&
          fresh.pendingOperation === expectedOperation;
        try {
          return await this.repository.save(
            fresh,
            unchanged
              ? { ...landed, ...settled }
              : {
                  ...landed,
                  pendingOperation:
                    eventExists && fresh.pendingOperation === "create"
                      ? "update"
                      : fresh.pendingOperation,
                },
          );
        } catch (retry) {
          failure = retry;
        }
      }
      throw failure;
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
