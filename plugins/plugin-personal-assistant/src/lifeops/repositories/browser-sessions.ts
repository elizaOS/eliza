/** Adapts LifeOps browser sessions persistence to canonical domain records. Preserves existing agent scoping, transaction handles, and conditional mutation contracts. */

import type { IAgentRuntime } from "@elizaos/core";
import type { BrowserBridgeCompanionStatus } from "@elizaos/plugin-browser";
import type { LifeOpsBrowserSession } from "../../contracts/index.js";
import {
  executeRawSql,
  sqlInteger,
  sqlJson,
  sqlQuote,
  sqlText,
} from "../sql.js";
import { parseBrowserSession } from "./browser-records.js";
export class BrowserSessionRepository {
  constructor(private readonly runtime: IAgentRuntime) {}
  async createBrowserSession(session: LifeOpsBrowserSession): Promise<void> {
    await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.life_workflow_browser_sessions (
        id, agent_id, domain, subject_type, subject_id, visibility_scope,
        context_policy, workflow_id, browser, companion_id, profile_id,
        window_id, tab_id, title, status, actions_json,
        current_action_index, awaiting_confirmation_for_action_id,
        result_json, metadata_json, created_at, updated_at, finished_at
      ) VALUES (
        ${sqlQuote(session.id)},
        ${sqlQuote(session.agentId)},
        ${sqlQuote(session.domain)},
        ${sqlQuote(session.subjectType)},
        ${sqlQuote(session.subjectId)},
        ${sqlQuote(session.visibilityScope)},
        ${sqlQuote(session.contextPolicy)},
        ${sqlText(session.workflowId)},
        ${sqlText(session.browser)},
        ${sqlText(session.companionId)},
        ${sqlText(session.profileId)},
        ${sqlText(session.windowId)},
        ${sqlText(session.tabId)},
        ${sqlQuote(session.title)},
        ${sqlQuote(session.status)},
        ${sqlJson(session.actions)},
        ${sqlInteger(session.currentActionIndex)},
        ${sqlText(session.awaitingConfirmationForActionId)},
        ${sqlJson(session.result)},
        ${sqlJson(session.metadata)},
        ${sqlQuote(session.createdAt)},
        ${sqlQuote(session.updatedAt)},
        ${sqlText(session.finishedAt)}
      )`,
    );
  }

  async updateBrowserSession(session: LifeOpsBrowserSession): Promise<void> {
    await executeRawSql(
      this.runtime,
      `UPDATE app_lifeops.life_workflow_browser_sessions
          SET domain = ${sqlQuote(session.domain)},
              subject_type = ${sqlQuote(session.subjectType)},
              subject_id = ${sqlQuote(session.subjectId)},
              visibility_scope = ${sqlQuote(session.visibilityScope)},
              context_policy = ${sqlQuote(session.contextPolicy)},
              workflow_id = ${sqlText(session.workflowId)},
              browser = ${sqlText(session.browser)},
              companion_id = ${sqlText(session.companionId)},
              profile_id = ${sqlText(session.profileId)},
              window_id = ${sqlText(session.windowId)},
              tab_id = ${sqlText(session.tabId)},
              title = ${sqlQuote(session.title)},
              status = ${sqlQuote(session.status)},
              actions_json = ${sqlJson(session.actions)},
              current_action_index = ${sqlInteger(session.currentActionIndex)},
              awaiting_confirmation_for_action_id = ${sqlText(session.awaitingConfirmationForActionId)},
              result_json = ${sqlJson(session.result)},
              metadata_json = ${sqlJson(session.metadata)},
              updated_at = ${sqlQuote(session.updatedAt)},
              finished_at = ${sqlText(session.finishedAt)}
        WHERE id = ${sqlQuote(session.id)}
          AND agent_id = ${sqlQuote(session.agentId)}`,
    );
  }

  async updateBrowserSessionIfAwaitingConfirmation(args: {
    session: LifeOpsBrowserSession;
    expectedActionId: string;
    expectedUpdatedAt: string;
  }): Promise<LifeOpsBrowserSession | null> {
    const { session } = args;
    const rows = await executeRawSql(
      this.runtime,
      `UPDATE app_lifeops.life_workflow_browser_sessions
          SET status = ${sqlQuote(session.status)},
              current_action_index = ${sqlInteger(session.currentActionIndex)},
              awaiting_confirmation_for_action_id = ${sqlText(session.awaitingConfirmationForActionId)},
              result_json = ${sqlJson(session.result)},
              metadata_json = ${sqlJson(session.metadata)},
              updated_at = ${sqlQuote(session.updatedAt)},
              finished_at = ${sqlText(session.finishedAt)}
        WHERE id = ${sqlQuote(session.id)}
          AND agent_id = ${sqlQuote(session.agentId)}
          AND status = 'awaiting_confirmation'
          AND awaiting_confirmation_for_action_id = ${sqlQuote(args.expectedActionId)}
          AND updated_at = ${sqlQuote(args.expectedUpdatedAt)}
          AND actions_json = ${sqlJson(session.actions)}
        RETURNING *`,
    );
    return rows[0] ? parseBrowserSession(rows[0]) : null;
  }

  async claimBrowserSession(
    agentId: string,
    companion: BrowserBridgeCompanionStatus,
    claimedAt: string,
  ): Promise<LifeOpsBrowserSession | null> {
    const rows = await executeRawSql(
      this.runtime,
      `WITH candidate AS (
         SELECT id
           FROM app_lifeops.life_workflow_browser_sessions
          WHERE agent_id = ${sqlQuote(agentId)}
            AND (browser IS NULL OR browser = ${sqlQuote(companion.browser)})
            AND (profile_id IS NULL OR profile_id = ${sqlQuote(companion.profileId)})
            AND (companion_id IS NULL OR companion_id = ${sqlQuote(companion.id)})
            AND (
              status = 'queued'
              OR (
                status = 'running'
                AND metadata_json::jsonb ->> 'claimedByCompanionId' = ${sqlQuote(companion.id)}
              )
            )
          ORDER BY
            CASE WHEN status = 'running' THEN 0 ELSE 1 END,
            created_at ASC,
            id ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
       )
       UPDATE app_lifeops.life_workflow_browser_sessions AS session
          SET status = 'running',
              browser = COALESCE(session.browser, ${sqlQuote(companion.browser)}),
              companion_id = ${sqlQuote(companion.id)},
              profile_id = COALESCE(session.profile_id, ${sqlQuote(companion.profileId)}),
              metadata_json = (session.metadata_json::jsonb || ${sqlJson({
                claimedAt,
                claimedByCompanionId: companion.id,
                claimedBrowser: companion.browser,
                claimedProfileId: companion.profileId,
              })}::jsonb)::text,
              updated_at = ${sqlQuote(claimedAt)}
         FROM candidate
        WHERE session.id = candidate.id
          AND session.agent_id = ${sqlQuote(agentId)}
        RETURNING session.*`,
    );
    return rows[0] ? parseBrowserSession(rows[0]) : null;
  }

  async beginBrowserSessionActionFromCompanion(args: {
    agentId: string;
    sessionId: string;
    companion: BrowserBridgeCompanionStatus;
    currentActionIndex: number;
    actionId: string;
    attemptId: string;
    startedAt: string;
  }): Promise<LifeOpsBrowserSession | null> {
    const attempt = {
      actionId: args.actionId,
      actionIndex: args.currentActionIndex,
      attemptId: args.attemptId,
      startedAt: args.startedAt,
    };
    const rows = await executeRawSql(
      this.runtime,
      `UPDATE app_lifeops.life_workflow_browser_sessions
          SET metadata_json = (metadata_json::jsonb || ${sqlJson({
            browserActionAttempt: attempt,
          })}::jsonb)::text,
              updated_at = ${sqlQuote(args.startedAt)}
        WHERE agent_id = ${sqlQuote(args.agentId)}
          AND id = ${sqlQuote(args.sessionId)}
          AND status = 'running'
          AND companion_id = ${sqlQuote(args.companion.id)}
          AND browser = ${sqlQuote(args.companion.browser)}
          AND profile_id = ${sqlQuote(args.companion.profileId)}
          AND current_action_index = ${sqlInteger(args.currentActionIndex)}
          AND (actions_json::jsonb -> ${sqlInteger(args.currentActionIndex)} ->> 'id') = ${sqlQuote(args.actionId)}
          AND NOT (metadata_json::jsonb ? 'browserActionAttempt')
        RETURNING *`,
    );
    return rows[0] ? parseBrowserSession(rows[0]) : null;
  }

  async requireBrowserSessionActionConfirmation(args: {
    agentId: string;
    sessionId: string;
    companion: BrowserBridgeCompanionStatus;
    currentActionIndex: number;
    actionId: string;
    updatedAt: string;
  }): Promise<LifeOpsBrowserSession | null> {
    const rows = await executeRawSql(
      this.runtime,
      `UPDATE app_lifeops.life_workflow_browser_sessions
          SET status = 'awaiting_confirmation',
              awaiting_confirmation_for_action_id = ${sqlQuote(args.actionId)},
              metadata_json = (metadata_json::jsonb - 'browserActionAttempt')::text,
              updated_at = ${sqlQuote(args.updatedAt)}
        WHERE agent_id = ${sqlQuote(args.agentId)}
          AND id = ${sqlQuote(args.sessionId)}
          AND status = 'running'
          AND companion_id = ${sqlQuote(args.companion.id)}
          AND browser = ${sqlQuote(args.companion.browser)}
          AND profile_id = ${sqlQuote(args.companion.profileId)}
          AND current_action_index = ${sqlInteger(args.currentActionIndex)}
          AND (actions_json::jsonb -> ${sqlInteger(args.currentActionIndex)} ->> 'id') = ${sqlQuote(args.actionId)}
          AND NOT (metadata_json::jsonb ? 'browserActionAttempt')
        RETURNING *`,
    );
    return rows[0] ? parseBrowserSession(rows[0]) : null;
  }

  async updateBrowserSessionProgressFromCompanion(args: {
    agentId: string;
    sessionId: string;
    companion: BrowserBridgeCompanionStatus;
    expectedActionIndex: number;
    completedActionId: string;
    attemptId: string;
    currentActionIndex: number;
    resultPatch: Record<string, unknown>;
    metadataPatch: Record<string, unknown>;
    updatedAt: string;
  }): Promise<LifeOpsBrowserSession | null> {
    if (args.currentActionIndex !== args.expectedActionIndex + 1) {
      return null;
    }
    const rows = await executeRawSql(
      this.runtime,
      `UPDATE app_lifeops.life_workflow_browser_sessions
          SET current_action_index = ${sqlInteger(args.currentActionIndex)},
              result_json = ${sqlJson(args.resultPatch)},
              metadata_json = ${sqlJson(args.metadataPatch)},
              updated_at = ${sqlQuote(args.updatedAt)}
        WHERE agent_id = ${sqlQuote(args.agentId)}
          AND id = ${sqlQuote(args.sessionId)}
          AND status = 'running'
          AND companion_id = ${sqlQuote(args.companion.id)}
          AND browser = ${sqlQuote(args.companion.browser)}
          AND profile_id = ${sqlQuote(args.companion.profileId)}
          AND current_action_index = ${sqlInteger(args.expectedActionIndex)}
          AND (actions_json::jsonb -> ${sqlInteger(args.expectedActionIndex)} ->> 'id') = ${sqlQuote(args.completedActionId)}
          AND metadata_json::jsonb -> 'browserActionAttempt' ->> 'actionId' = ${sqlQuote(args.completedActionId)}
          AND (metadata_json::jsonb -> 'browserActionAttempt' ->> 'actionIndex')::integer = ${sqlInteger(args.expectedActionIndex)}
          AND metadata_json::jsonb -> 'browserActionAttempt' ->> 'attemptId' = ${sqlQuote(args.attemptId)}
          AND ${sqlInteger(args.currentActionIndex)} <= jsonb_array_length(actions_json::jsonb)
        RETURNING *`,
    );
    return rows[0] ? parseBrowserSession(rows[0]) : null;
  }

  async completeBrowserSessionFromCompanion(args: {
    agentId: string;
    sessionId: string;
    companion: BrowserBridgeCompanionStatus;
    status: Extract<LifeOpsBrowserSession["status"], "done" | "failed">;
    expectedActionIndex: number;
    completedActionId: string | null;
    attemptId: string | null;
    resultPatch: Record<string, unknown>;
    updatedAt: string;
  }): Promise<LifeOpsBrowserSession | null> {
    const executionFence =
      args.status === "failed"
        ? `AND current_action_index = ${sqlInteger(args.expectedActionIndex)}
           AND (actions_json::jsonb -> ${sqlInteger(args.expectedActionIndex)} ->> 'id') = ${sqlQuote(args.completedActionId ?? "")}
           AND metadata_json::jsonb -> 'browserActionAttempt' ->> 'actionId' = ${sqlQuote(args.completedActionId ?? "")}
           AND (metadata_json::jsonb -> 'browserActionAttempt' ->> 'actionIndex')::integer = ${sqlInteger(args.expectedActionIndex)}
           AND metadata_json::jsonb -> 'browserActionAttempt' ->> 'attemptId' = ${sqlQuote(args.attemptId ?? "")}`
        : args.expectedActionIndex === 0
          ? `AND current_action_index = 0
             AND jsonb_array_length(actions_json::jsonb) = 0
             AND NOT (metadata_json::jsonb ? 'browserActionAttempt')`
          : `AND current_action_index = ${sqlInteger(args.expectedActionIndex)}
             AND current_action_index = jsonb_array_length(actions_json::jsonb)
             AND metadata_json::jsonb -> 'browserActionReceipt' ->> 'actionId' = ${sqlQuote(args.completedActionId ?? "")}
             AND (metadata_json::jsonb -> 'browserActionReceipt' ->> 'actionIndex')::integer = ${sqlInteger(args.expectedActionIndex - 1)}
             AND metadata_json::jsonb -> 'browserActionReceipt' ->> 'attemptId' = ${sqlQuote(args.attemptId ?? "")}
             AND NOT (metadata_json::jsonb ? 'browserActionAttempt')`;
    const rows = await executeRawSql(
      this.runtime,
      `UPDATE app_lifeops.life_workflow_browser_sessions
          SET status = ${sqlQuote(args.status)},
              current_action_index = jsonb_array_length(actions_json::jsonb),
              result_json = (result_json::jsonb || ${sqlJson(args.resultPatch)}::jsonb)::text,
              updated_at = ${sqlQuote(args.updatedAt)},
              finished_at = ${sqlQuote(args.updatedAt)}
        WHERE agent_id = ${sqlQuote(args.agentId)}
          AND id = ${sqlQuote(args.sessionId)}
          AND status = 'running'
          AND companion_id = ${sqlQuote(args.companion.id)}
          AND browser = ${sqlQuote(args.companion.browser)}
          AND profile_id = ${sqlQuote(args.companion.profileId)}
          ${executionFence}
          AND (
            ${sqlQuote(args.status)} = 'failed'
            OR current_action_index = jsonb_array_length(actions_json::jsonb)
          )
        RETURNING *`,
    );
    return rows[0] ? parseBrowserSession(rows[0]) : null;
  }

  async getBrowserSession(
    agentId: string,
    sessionId: string,
  ): Promise<LifeOpsBrowserSession | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.life_workflow_browser_sessions
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id = ${sqlQuote(sessionId)}
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseBrowserSession(row) : null;
  }

  async listBrowserSessions(agentId: string): Promise<LifeOpsBrowserSession[]> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.life_workflow_browser_sessions
        WHERE agent_id = ${sqlQuote(agentId)}
        ORDER BY updated_at DESC, created_at DESC`,
    );
    return rows.map(parseBrowserSession);
  }

  async deleteBrowserSession(
    agentId: string,
    sessionId: string,
  ): Promise<void> {
    await executeRawSql(
      this.runtime,
      `DELETE FROM app_lifeops.life_workflow_browser_sessions
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id = ${sqlQuote(sessionId)}`,
    );
  }
}
