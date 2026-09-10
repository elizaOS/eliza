/**
 * Persists the owner's linked-calendar destination and dispatch pause state.
 * Revision-checked writes keep concurrent account reviews from replacing a
 * newer decision. Pausing changes only control state, never event operations.
 */
import { ElizaError, type IAgentRuntime } from "@elizaos/core";
import { executeRawSql, sqlInteger, sqlQuote } from "../internal/sql.js";

export interface LinkedCalendarDestination {
  connectorAccountId: string;
  providerCalendarId: string;
}

export interface LinkedCalendarControl {
  revision: number;
  paused: boolean;
  destination: LinkedCalendarDestination | null;
}

function invalidState(): never {
  throw new ElizaError("The saved calendar sync control is invalid.", {
    code: "LINKED_CALENDAR_CONTROL_INVALID",
  });
}

function parseControl(row: Record<string, unknown>): LinkedCalendarControl {
  const { revision, paused, connector_account_id, provider_calendar_id } = row;
  if (
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    typeof paused !== "boolean"
  )
    return invalidState();
  if (connector_account_id === null && provider_calendar_id === null) {
    if (!paused) return invalidState();
    return { revision, paused, destination: null };
  }
  if (
    typeof connector_account_id !== "string" ||
    !connector_account_id.trim() ||
    typeof provider_calendar_id !== "string" ||
    !provider_calendar_id.trim()
  )
    return invalidState();
  return {
    revision,
    paused,
    destination: {
      connectorAccountId: connector_account_id,
      providerCalendarId: provider_calendar_id,
    },
  };
}

/** Storage boundary only; the service owns provider verification and drain. */
export class LinkedCalendarControlRepository {
  constructor(private readonly runtime: IAgentRuntime) {}

  async read(): Promise<LinkedCalendarControl> {
    await executeRawSql(
      this.runtime,
      `
      INSERT INTO app_calendar.linked_calendar_control (agent_id)
      VALUES (${sqlQuote(this.runtime.agentId)}) ON CONFLICT DO NOTHING`,
    );
    const rows = await executeRawSql(
      this.runtime,
      `
      SELECT * FROM app_calendar.linked_calendar_control
      WHERE agent_id = ${sqlQuote(this.runtime.agentId)}`,
    );
    if (!rows[0]) return invalidState();
    return parseControl(rows[0]);
  }

  async selectDestination(
    expectedRevision: number,
    destination: LinkedCalendarDestination | null,
  ): Promise<LinkedCalendarControl> {
    if (
      destination &&
      (!destination.connectorAccountId.trim() ||
        !destination.providerCalendarId.trim())
    ) {
      throw new ElizaError("Choose an account and calendar destination.", {
        code: "LINKED_CALENDAR_DESTINATION_REQUIRED",
      });
    }
    return this.update(
      expectedRevision,
      `
      connector_account_id = ${destination ? sqlQuote(destination.connectorAccountId) : "NULL"},
      provider_calendar_id = ${destination ? sqlQuote(destination.providerCalendarId) : "NULL"}`,
      "paused = TRUE",
    );
  }

  async pause(expectedRevision: number): Promise<LinkedCalendarControl> {
    return this.update(expectedRevision, "paused = TRUE", "TRUE");
  }

  async resume(expectedRevision: number): Promise<LinkedCalendarControl> {
    return this.update(
      expectedRevision,
      "paused = FALSE",
      "connector_account_id IS NOT NULL AND provider_calendar_id IS NOT NULL",
    );
  }

  private async update(
    expectedRevision: number,
    assignments: string,
    condition: string,
  ): Promise<LinkedCalendarControl> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new ElizaError(
        "Refresh the calendar sync review before continuing.",
        {
          code: "LINKED_CALENDAR_CONTROL_REVISION_INVALID",
        },
      );
    }
    const rows = await executeRawSql(
      this.runtime,
      `
      UPDATE app_calendar.linked_calendar_control
      SET ${assignments}, revision = revision + 1
      WHERE agent_id = ${sqlQuote(this.runtime.agentId)}
        AND revision = ${sqlInteger(expectedRevision)} AND (${condition})
      RETURNING *`,
    );
    if (!rows[0]) {
      throw new ElizaError(
        "Calendar sync changed or is not ready for this transition. Refresh its review.",
        { code: "LINKED_CALENDAR_CONTROL_TRANSITION_REJECTED" },
      );
    }
    return parseControl(rows[0]);
  }
}
