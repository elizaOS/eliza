/**
 * Should-respond task runner.
 *
 * For each (case, mode), runs `--n` generations and emits one `CaseMetric` per
 * call. Score = (parse-success, schema-valid, label-match) where label is the
 * ground-truth `shouldRespond` enum.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildMetric,
  checkShouldRespondSchema,
  isPlainObject,
  tryParseJson,
} from "../metrics.ts";
import type {
  CaseMetric,
  ModeAdapter,
  ModeRequest,
  ShouldRespondFixture,
  SkeletonHint,
} from "../types.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const FIXTURE_PATH = path.join(HERE, "..", "fixtures", "should-respond.json");

interface ShouldRespondFixtureFile {
  note: string;
  cases: ShouldRespondFixture[];
}

export function loadShouldRespondFixtures(): ShouldRespondFixture[] {
  const raw = readFileSync(FIXTURE_PATH, "utf8");
  const parsed = JSON.parse(raw) as ShouldRespondFixtureFile;
  return parsed.cases;
}

const SYSTEM_PROMPT = [
  "You are Eliza, an AI assistant. Your job here is to decide whether to respond to an incoming message.",
  'Output JSON of the form {"shouldRespond": "RESPOND"} (or "IGNORE" / "STOP"). No prose, no extra fields.',
  "RESPOND when the message is addressed to you, asks a question you can help with, or continues an active conversation.",
  "IGNORE when the message is between other people, is small-talk you were not addressed in, or is otherwise not yours to handle.",
  "STOP only when the user explicitly asks you to stop / terminate the interaction.",
  "In a DM channel default to RESPOND unless the user asks you to stop.",
].join("\n");

function buildSkeletonHint(): SkeletonHint {
  return {
    type: "object",
    freeFields: [],
    enumKey: "shouldRespond",
    enumValues: ["RESPOND", "IGNORE", "STOP"],
  };
}

function buildJsonSchema() {
  return {
    type: "object",
    properties: {
      shouldRespond: {
        type: "string",
        enum: ["RESPOND", "IGNORE", "STOP"],
      },
    },
    required: ["shouldRespond"],
    additionalProperties: false,
  };
}

function buildUserPrompt(fixture: ShouldRespondFixture): string {
  const channel = fixture.channelType ?? "unspecified";
  return [
    `channel_type: ${channel}`,
    `incoming_message: ${JSON.stringify(fixture.input)}`,
  ].join("\n");
}

export async function runShouldRespondTask(args: {
  mode: ModeAdapter;
  n: number;
}): Promise<CaseMetric[]> {
  const fixtures = loadShouldRespondFixtures();
  const skeletonHint = buildSkeletonHint();
  const jsonSchema = buildJsonSchema();
  const metrics: CaseMetric[] = [];
  for (const fixture of fixtures) {
    const userPrompt = buildUserPrompt(fixture);
    for (let i = 0; i < args.n; i += 1) {
      const request: ModeRequest = {
        taskId: "should_respond",
        caseId: `${fixture.id}#${i}`,
        systemPrompt: SYSTEM_PROMPT,
        userPrompt,
        jsonSchema,
        skeletonHint,
        maxTokens: 24,
      };
      const result = await args.mode.generate(request);
      const parsed = tryParseJson(result.rawOutput);
      const parseSuccess = parsed !== null;
      const schemaValid = parseSuccess
        ? checkShouldRespondSchema(parsed)
        : false;
      let labelMatch: boolean | null = null;
      if (schemaValid && parsed !== null && isPlainObject(parsed)) {
        labelMatch = parsed.shouldRespond === fixture.expected;
      }
      metrics.push(
        buildMetric({
          taskId: "should_respond",
          modeId: args.mode.id,
          caseId: request.caseId,
          result,
          parse_success: parseSuccess,
          schema_valid: schemaValid,
          label_match: labelMatch,
        }),
      );
    }
  }
  return metrics;
}
