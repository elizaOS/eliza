/**
 * GET_APP_EARNINGS — "how much have I earned from app X?" READ-ONLY.
 *
 * Resolves the app, calls the typed `client.getAppEarnings(id)` (wrapping
 * `GET /api/v1/apps/:id/earnings`), and formats the earnings summary:
 * withdrawable balance, pending balance, lifetime earnings, total withdrawn, and
 * the payout threshold. Degrades gracefully when there is no key, no earnings, or
 * monetization is off. No mutating calls, no money movement.
 */

import type { AppDto } from "@elizaos/cloud-sdk";
import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import {
  extractAppReference,
  getCloudClient,
  resolveApp,
  resolveCloudApiKey,
} from "../client.js";

const NO_KEY_MESSAGE =
  "I can't reach Eliza Cloud yet — no Cloud API key is configured. Add your ELIZAOS_CLOUD_API_KEY and I can check your earnings.";
const NO_REFERENCE_MESSAGE =
  "Which app's earnings would you like to see? Tell me its name.";
const ERROR_MESSAGE =
  "I couldn't fetch those earnings right now — the Cloud API returned an error. Try again in a moment.";

/** The earnings fields the summary block reads. */
export interface EarningsView {
  withdrawableBalance: number;
  pendingBalance: number;
  totalLifetimeEarnings: number;
  totalWithdrawn: number;
  payoutThreshold: number;
}

function asNum(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** Pull the earnings summary out of the (loosely-typed) earnings envelope. */
export function extractEarningsView(
  earnings: Record<string, unknown> | undefined,
): EarningsView | null {
  const summary =
    earnings && typeof earnings.summary === "object" && earnings.summary
      ? (earnings.summary as Record<string, unknown>)
      : null;
  if (!summary) return null;
  return {
    withdrawableBalance: asNum(summary.withdrawableBalance) ?? 0,
    pendingBalance: asNum(summary.pendingBalance) ?? 0,
    totalLifetimeEarnings: asNum(summary.totalLifetimeEarnings) ?? 0,
    totalWithdrawn: asNum(summary.totalWithdrawn) ?? 0,
    payoutThreshold: asNum(summary.payoutThreshold) ?? 0,
  };
}

function monetizationEnabled(
  monetization: Record<string, unknown> | undefined,
): boolean {
  return monetization?.enabled === true;
}

/** Human earnings block for the reply (exported for tests). */
export function formatEarnings(
  app: AppDto,
  earnings: Record<string, unknown> | undefined,
  monetization: Record<string, unknown> | undefined,
): string {
  const view = extractEarningsView(earnings);
  const enabled = monetizationEnabled(monetization) || app.monetization_enabled;

  if (!view || view.totalLifetimeEarnings === 0) {
    if (!enabled) {
      return `"${app.name}" isn't earning yet — monetization is off. Turn it on and I'll start tracking earnings.`;
    }
    return `"${app.name}" has no earnings yet. Once users run paid inference through it, earnings will show up here.`;
  }

  const usd = (n: number): string => `$${n.toFixed(2)}`;
  const lines = [
    `"${app.name}" earnings:`,
    `• Withdrawable now: ${usd(view.withdrawableBalance)}`,
  ];
  if (view.pendingBalance > 0) {
    lines.push(`• Pending (clearing): ${usd(view.pendingBalance)}`);
  }
  lines.push(`• Lifetime: ${usd(view.totalLifetimeEarnings)}`);
  if (view.totalWithdrawn > 0) {
    lines.push(`• Withdrawn so far: ${usd(view.totalWithdrawn)}`);
  }
  if (view.payoutThreshold > 0) {
    const ready = view.withdrawableBalance >= view.payoutThreshold;
    lines.push(
      ready
        ? `You can withdraw now (minimum payout ${usd(view.payoutThreshold)}).`
        : `Minimum payout is ${usd(view.payoutThreshold)} — keep earning to reach it.`,
    );
  }
  return lines.join("\n");
}

function notFoundMessage(reference: string, available: string[]): string {
  const base = `I couldn't find an app matching "${reference}".`;
  if (available.length === 0) {
    return `${base} You don't have any apps on Eliza Cloud yet.`;
  }
  return `${base} Your apps are: ${available.join(", ")}.`;
}

export const getAppEarningsAction: Action = {
  name: "GET_APP_EARNINGS",
  similes: [
    "HOW_MUCH_HAVE_I_EARNED",
    "MY_EARNINGS",
    "APP_EARNINGS",
    "SHOW_EARNINGS",
    "CHECK_EARNINGS",
  ],
  description:
    "Show how much an Eliza Cloud app has earned — withdrawable balance, pending balance, lifetime earnings, and amount withdrawn. Read-only. Use when the user asks how much they've earned or about an app's revenue/earnings.",
  descriptionCompressed: "Show a Cloud app's earnings (read-only).",
  contexts: ["settings", "finance", "apps"],
  contextGate: { anyOf: ["settings", "finance", "apps"] },

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    return resolveCloudApiKey(runtime) !== null;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const client = getCloudClient(runtime);
    if (!client) {
      await callback?.({ text: NO_KEY_MESSAGE, actions: ["GET_APP_EARNINGS"] });
      return {
        success: false,
        text: "No Eliza Cloud API key configured.",
        userFacingText: NO_KEY_MESSAGE,
        data: { reason: "no_key" },
      };
    }

    const reference = extractAppReference(message, options);
    if (!reference) {
      await callback?.({
        text: NO_REFERENCE_MESSAGE,
        actions: ["GET_APP_EARNINGS"],
      });
      return {
        success: false,
        text: "No app reference supplied.",
        userFacingText: NO_REFERENCE_MESSAGE,
        data: { reason: "no_reference" },
      };
    }

    let app: AppDto | null;
    let available: string[];
    try {
      ({ app, available } = await resolveApp(client, reference));
    } catch (err) {
      logger.warn(
        `[GET_APP_EARNINGS] Failed to resolve app "${reference}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      await callback?.({ text: ERROR_MESSAGE, actions: ["GET_APP_EARNINGS"] });
      return {
        success: false,
        text: "Failed to resolve Eliza Cloud app.",
        userFacingText: ERROR_MESSAGE,
        error: err instanceof Error ? err : new Error(String(err)),
        data: { reason: "error" },
      };
    }

    if (!app) {
      const msg = notFoundMessage(reference, available);
      await callback?.({ text: msg, actions: ["GET_APP_EARNINGS"] });
      return {
        success: false,
        text: `No app matched "${reference}".`,
        userFacingText: msg,
        data: { reason: "not_found", reference },
      };
    }

    const target = app;
    try {
      const res = await client.getAppEarnings(target.id);
      const reply = formatEarnings(target, res.earnings, res.monetization);
      const view = extractEarningsView(res.earnings);
      await callback?.({ text: reply, actions: ["GET_APP_EARNINGS"] });
      return {
        success: true,
        text: `Fetched earnings for ${target.name}.`,
        userFacingText: reply,
        verifiedUserFacing: true,
        data: {
          app: { id: target.id, name: target.name, slug: target.slug },
          withdrawableBalance: view?.withdrawableBalance ?? 0,
          lifetimeEarnings: view?.totalLifetimeEarnings ?? 0,
        },
      };
    } catch (err) {
      logger.warn(
        `[GET_APP_EARNINGS] getAppEarnings(${target.id}) failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      await callback?.({ text: ERROR_MESSAGE, actions: ["GET_APP_EARNINGS"] });
      return {
        success: false,
        text: "Failed to fetch earnings.",
        userFacingText: ERROR_MESSAGE,
        error: err instanceof Error ? err : new Error(String(err)),
        data: { reason: "error" },
      };
    }
  },

  examples: [
    [
      {
        name: "{{user}}",
        content: { text: "how much have I earned from Acme Bot?" },
      },
      {
        name: "{{agent}}",
        content: {
          text: '"Acme Bot" earnings:\n• Withdrawable now: $42.00\n• Lifetime: $58.00\nYou can withdraw now (minimum payout $25.00).',
          actions: ["GET_APP_EARNINGS"],
        },
      },
    ],
  ],
};

export default getAppEarningsAction;
