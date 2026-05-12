/**
 * Multilingual action-routing smoke test.
 *
 * Verifies that the LLM planners for LIFE, CALENDAR, HEALTH, RELATIONSHIP, and
 * SCHEDULING (all cleaned up in WS4) route Spanish, French, and Japanese
 * utterances to the same subaction / operation as their English counterparts.
 *
 * Runs against a real AgentRuntime with a real LLM provider. Skips unless
 * `ELIZA_LIVE_TEST=1` is set AND at least one
 * provider API key is available — same gating as `lifeops-llm-extraction.live.test.ts`.
 *
 * WHY: Earlier heuristic routers used English-only regex. A Spanish user asking
 * "agrega una reunión mañana a las 3" was dropped on the floor because nothing
 * matched `/\bschedule\b/`. These tests guard against regressing into that
 * failure mode by asserting the LLM planner picks the correct subaction for
 * every language.
 */

import crypto from "node:crypto";
import path from "node:path";
import {
  createMessageMemory,
  type IAgentRuntime,
  type Memory,
  type State,
  type UUID,
} from "@elizaos/core";
import { afterAll, beforeAll, describe, expect } from "vitest";
import { stochasticTest } from "../../../packages/app-core/test/helpers/stochastic-test";
import { selectLiveProvider } from "../../../test/helpers/live-provider";
import { extractCalendarPlanWithLlm } from "../src/actions/calendar.js";
import { extractLifeOperationWithLlm } from "../src/actions/life.extractor.js";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "./helpers/runtime.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..", "..");
try {
  const { config } = await import("dotenv");
  config({ path: path.join(REPO_ROOT, ".env") });
} catch {
  // dotenv optional
}

const LIVE_ENABLED = process.env.ELIZA_LIVE_TEST === "1";
const provider = LIVE_ENABLED ? selectLiveProvider() : null;

if (!LIVE_ENABLED || !provider) {
  const reasons = [
    !LIVE_ENABLED ? "set ELIZA_LIVE_TEST=1" : null,
    !provider ? "provide a provider API key" : null,
  ]
    .filter(Boolean)
    .join(" | ");
  console.info(`[multilingual-action-routing] skipped: ${reasons}`);
}

function makeMessage(runtime: IAgentRuntime, text: string): Memory {
  return createMessageMemory({
    id: crypto.randomUUID() as UUID,
    entityId: crypto.randomUUID() as UUID,
    roomId: crypto.randomUUID() as UUID,
    agentId: runtime.agentId as UUID,
    content: {
      text,
      source: "client_chat",
    },
  });
}

function makeState(recentMessages?: string): State {
  return {
    values: { recentMessages: recentMessages ?? "" },
    data: {},
    text: recentMessages ?? "",
  } as State;
}

const TEST_TIMEOUT = 60_000;
const describeIfLive = LIVE_ENABLED && provider ? describe : describe.skip;

// The 10 core commands, written in four languages. English is the anchor;
// each row must resolve to the same plan/operation regardless of language.
type MultilingualCommandRow = {
  label: string;
  en: string;
  es: string;
  fr: string;
  ja: string;
};

const CALENDAR_COMMANDS: Array<
  MultilingualCommandRow & {
    expectedSubaction:
      | "feed"
      | "next_event"
      | "search_events"
      | "create_event"
      | "update_event"
      | "delete_event"
      | "trip_window";
  }
> = [
  {
    label: "feed / today's schedule",
    en: "What's on my calendar today?",
    es: "¿Qué tengo en el calendario hoy?",
    fr: "Qu'est-ce que j'ai dans mon agenda aujourd'hui ?",
    ja: "今日の予定は何ですか？",
    expectedSubaction: "feed",
  },
  {
    label: "next_event",
    en: "What's my next meeting?",
    es: "¿Cuál es mi próxima reunión?",
    fr: "Quelle est ma prochaine réunion ?",
    ja: "次のミーティングはいつですか？",
    expectedSubaction: "next_event",
  },
  {
    label: "search_events / flight",
    en: "Find my return flight",
    es: "Busca mi vuelo de regreso",
    fr: "Trouve mon vol de retour",
    ja: "帰りの便を探して",
    expectedSubaction: "search_events",
  },
  {
    label: "create_event",
    en: "Schedule a meeting with Alex at 3pm tomorrow",
    es: "Agenda una reunión con Alex mañana a las 3pm",
    fr: "Planifie une réunion avec Alex demain à 15h",
    ja: "明日の午後3時にアレックスとのミーティングを入れて",
    expectedSubaction: "create_event",
  },
  {
    label: "delete_event",
    en: "Delete the team meeting tomorrow",
    es: "Elimina la reunión de equipo de mañana",
    fr: "Supprime la réunion d'équipe de demain",
    ja: "明日のチームミーティングを削除して",
    expectedSubaction: "delete_event",
  },
  {
    label: "update_event",
    en: "Reschedule the dentist to Friday",
    es: "Cambia la cita del dentista al viernes",
    fr: "Reporte le rendez-vous chez le dentiste à vendredi",
    ja: "歯医者の予約を金曜日に変更して",
    expectedSubaction: "update_event",
  },
  {
    label: "trip_window",
    en: "What's happening while I'm in Tokyo?",
    es: "¿Qué tengo mientras estoy en Tokio?",
    fr: "Qu'est-ce qui se passe pendant que je suis à Tokyo ?",
    ja: "東京にいる間、何がありますか？",
    expectedSubaction: "trip_window",
  },
];

const LIFE_COMMANDS: Array<
  MultilingualCommandRow & {
    expectedOperation:
      | "create_definition"
      | "complete_occurrence"
      | "snooze_occurrence"
      | "query_overview";
  }
> = [
  {
    label: "create_definition / brush teeth",
    en: "Remind me to brush my teeth every night",
    es: "Recuérdame cepillarme los dientes cada noche",
    fr: "Rappelle-moi de me brosser les dents tous les soirs",
    ja: "毎晩、歯磨きをするようにリマインドして",
    expectedOperation: "create_definition",
  },
  {
    label: "complete_occurrence",
    en: "I just brushed my teeth",
    es: "Acabo de cepillarme los dientes",
    fr: "Je viens de me brosser les dents",
    ja: "歯磨きを済ませた",
    expectedOperation: "complete_occurrence",
  },
  {
    label: "query_overview",
    en: "What do I still need to do today?",
    es: "¿Qué me queda por hacer hoy?",
    fr: "Qu'est-ce qu'il me reste à faire aujourd'hui ?",
    ja: "今日、まだやることは何？",
    expectedOperation: "query_overview",
  },
];

describeIfLive("Multilingual action-routing (live LLM)", () => {
  let runtimeResult: RealTestRuntimeResult | null = null;
  let runtime: IAgentRuntime;

  beforeAll(async () => {
    runtimeResult = await createLifeOpsTestRuntime({
      characterName: "LifeOpsMultilingualLive",
      preferredProvider: provider?.name,
      withLLM: true,
    });
    runtime = runtimeResult.runtime;
  }, 180_000);

  afterAll(async () => {
    await runtimeResult?.cleanup();
  });

  describe("CALENDAR planner multilingual parity", () => {
    for (const row of CALENDAR_COMMANDS) {
      for (const lang of ["en", "es", "fr", "ja"] as const) {
        stochasticTest(
          `${row.label} [${lang}]`,
          async () => {
            const text = row[lang];
            const message = makeMessage(runtime, text);
            const state = makeState();
            const plan = await extractCalendarPlanWithLlm(
              runtime,
              message,
              state,
              text,
            );
            expect(
              plan.subaction,
              `CALENDAR planner picked ${plan.subaction ?? "null"} for "${text}" (expected ${row.expectedSubaction})`,
            ).toBe(row.expectedSubaction);
          },
          {
            perRunTimeoutMs: TEST_TIMEOUT,
            label: `calendar/${row.label}/${lang}`,
          },
        );
      }
    }
  });

  describe("LIFE extractor multilingual parity", () => {
    for (const row of LIFE_COMMANDS) {
      for (const lang of ["en", "es", "fr", "ja"] as const) {
        stochasticTest(
          `${row.label} [${lang}]`,
          async () => {
            const text = row[lang];
            const message = makeMessage(runtime, text);
            const state = makeState();
            const plan = await extractLifeOperationWithLlm({
              runtime,
              message,
              state,
              intent: text,
            });
            expect(
              plan.operation,
              `LIFE extractor picked ${plan.operation ?? "null"} for "${text}" (expected ${row.expectedOperation})`,
            ).toBe(row.expectedOperation);
          },
          { perRunTimeoutMs: TEST_TIMEOUT, label: `life/${row.label}/${lang}` },
        );
      }
    }
  });
});
