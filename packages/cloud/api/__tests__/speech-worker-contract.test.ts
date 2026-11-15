/**
 * Source contract for the staging speech host. Pure config checks: never
 * contacts Cloudflare, reads no secret values and proves no live latency.
 */
import { describe, expect, test } from "bun:test";
import {
  checkSpeechWorkerContract,
  loadSpeechWorkerContractInput,
  SPEECH_WORKER_REQUIRED_SECRETS,
  type SpeechWorkerContractInput,
  type WorkerConfig,
} from "../../speech-worker/verify-staging-contract";

const committed = await loadSpeechWorkerContractInput();

function mutate(change: (input: SpeechWorkerContractInput) => void): string[] {
  const input = structuredClone({
    ...committed,
    coordinatorVariables: [...committed.coordinatorVariables],
    targetBase: committed.targetBase.href,
    sourceBase: committed.sourceBase.href,
  });
  const restored: SpeechWorkerContractInput = {
    ...input,
    coordinatorVariables: new Set(input.coordinatorVariables),
    targetBase: new URL(input.targetBase),
    sourceBase: new URL(input.sourceBase),
  };
  change(restored);
  return checkSpeechWorkerContract(restored);
}

const stagingBindings = (input: SpeechWorkerContractInput) =>
  input.source.env!.staging!.durable_objects!.bindings!;
const speechBinding = (config: WorkerConfig | undefined) =>
  config?.durable_objects?.bindings?.find(
    (binding) => binding.name === "SPEECH_RELAY_SESSIONS",
  );

describe("staging speech host source contract", () => {
  test("the committed configuration satisfies the contract", () => {
    expect(checkSpeechWorkerContract(committed)).toEqual([]);
  });

  test("staging keeps the API host until a reviewed binding change; production stays local", () => {
    expect(speechBinding(committed.source.env?.staging)).toEqual({
      name: "SPEECH_RELAY_SESSIONS",
      class_name: "SpeechRelayCoordinator",
    });
    expect(speechBinding(committed.source.env?.production)).toEqual({
      name: "SPEECH_RELAY_SESSIONS",
      class_name: "SpeechRelayCoordinator",
    });
    expect(
      mutate((input) => {
        speechBinding(input.source.env!.staging)!.script_name =
          "eliza-cloud-speech-staging";
      }),
    ).toEqual([]);
  });

  test("the scan reaches the coordinator's provider, flag and usage reads", () => {
    for (const name of [
      "CARTESIA_API_KEY",
      "CARTESIA_STT_USD_PER_CREDIT",
      "VOICE_SPEECH_RELAY_ENABLED",
      "VOICE_REALTIME_CARTESIA_VOICE_ID",
      "VOICE_REALTIME_ORG_DAILY_MINUTES",
      "VOICE_REALTIME_USER_DAILY_MINUTES",
      "CLOUD_VOICE_USAGE_BACKEND",
      "KV_REST_API_URL",
    ])
      expect(committed.coordinatorVariables.has(name)).toBe(true);
  });

  test("required secrets are names only and never plain-text vars", () => {
    expect([...SPEECH_WORKER_REQUIRED_SECRETS]).toEqual([
      "CARTESIA_API_KEY",
      "CARTESIA_STT_USD_PER_CREDIT",
      "DATABASE_URL",
      "KV_REST_API_URL",
      "KV_REST_API_TOKEN",
    ]);
    expect(
      mutate((input) => {
        input.target.vars!.CARTESIA_API_KEY = "placeholder";
      }),
    ).toContain("Secret must not be a plain-text variable: CARTESIA_API_KEY");
  });

  test.each<[string, (input: SpeechWorkerContractInput) => void, string]>([
    [
      "production switched before staging proves it",
      (input) => {
        speechBinding(input.source.env!.production)!.script_name =
          "eliza-cloud-speech-staging";
      },
      "Production speech binding must stay on the production API Worker",
    ],
    [
      "staging selects an unknown speech host",
      (input) => {
        speechBinding(input.source.env!.staging)!.script_name =
          "eliza-cloud-unreviewed-staging";
      },
      "Staging API speech binding must use the API or lean speech host",
    ],
    [
      "API namespace transferred away",
      (input) => {
        input.source.env!.staging!.exports!.SpeechRelayCoordinator = {
          type: "durable-object",
          state: "transferred",
          transferred_to: "eliza-cloud-speech-staging",
        };
      },
      "Staging API must keep exporting its SpeechRelayCoordinator namespace (no transfer, no deletion)",
    ],
    [
      "API namespace deleted",
      (input) => {
        delete input.source.env!.staging!.exports!.SpeechRelayCoordinator;
      },
      "Staging API must keep exporting its SpeechRelayCoordinator namespace (no transfer, no deletion)",
    ],
    [
      "legacy migrations mixed with declarative exports",
      (input) => {
        input.target.migrations = [
          { tag: "v1", new_sqlite_classes: ["SpeechRelayCoordinator"] },
        ];
      },
      "Declarative exports cannot mix with legacy migrations",
    ],
    [
      "a second class exported",
      (input) => {
        input.target.exports!.InferenceAdmissionGate = {
          type: "durable-object",
          storage: "sqlite",
        };
      },
      "Target must declare exactly one live SQLite SpeechRelayCoordinator export",
    ],
    [
      "a public route",
      (input) => {
        input.target.routes = [{ pattern: "speech.example/*" }];
      },
      "Speech host must have no public routes",
    ],
    [
      "a new Hyperdrive resource",
      (input) => {
        input.target.hyperdrive = [
          { binding: "HYPERDRIVE", id: "00000000000000000000000000000000" },
        ];
      },
      "Hyperdrive must reuse exactly the staging HYPERDRIVE resource",
    ],
    [
      "a new KV namespace",
      (input) => {
        input.target.kv_namespaces = [
          { binding: "CACHE_KV", id: "00000000000000000000000000000000" },
        ];
      },
      "KV must reuse exactly the staging CACHE_KV resource",
    ],
    [
      "a different admission namespace",
      (input) => {
        input.target.durable_objects!.bindings![1]!.script_name =
          "eliza-cloud-api-staging";
      },
      "Target Durable Object bindings must be the self-binding, the adopted admission gate and API voice usage",
    ],
    [
      "the speech flag drifting from the API",
      (input) => {
        input.target.vars!.VOICE_SPEECH_RELAY_ENABLED = "false";
      },
      "Target variable differs from staging: VOICE_SPEECH_RELAY_ENABLED",
    ],
    [
      "a coordinator variable missing on the host",
      (input) => {
        delete input.target.vars!.VOICE_REALTIME_CARTESIA_VOICE_ID;
      },
      "Coordinator variable must match staging: VOICE_REALTIME_CARTESIA_VOICE_ID",
    ],
    [
      "an API-only voice usage limit",
      (input) => {
        input.source.env!.staging!.vars!.VOICE_REALTIME_USER_DAILY_MINUTES =
          "1";
      },
      "Coordinator variable must match staging: VOICE_REALTIME_USER_DAILY_MINUTES",
    ],
    [
      "the direct Redis backend missing on the host",
      (input) => {
        delete input.target.vars!.DIRECT_REDIS_BACKEND;
      },
      "Coordinator variable must match staging: DIRECT_REDIS_BACKEND",
    ],
    [
      "an admission variable missing on the host",
      (input) => {
        delete input.target.vars!.INFERENCE_PASSTHROUGH_STREAMING;
      },
      "Admission variable must also match on the speech host: INFERENCE_PASSTHROUGH_STREAMING",
    ],
    [
      "alias drift",
      (input) => {
        input.target.alias!.undici = "./src/other-undici.ts";
      },
      "Build aliases must resolve to the exact canonical staging map, without extra aliases",
    ],
    [
      "an entry that is not the canonical class",
      (input) => {
        input.entry = "export class SpeechRelayCoordinator {}";
      },
      "Entry must reuse the canonical speech coordinator class",
    ],
  ])("rejects %s", (_name, change, message) => {
    expect(mutate(change)).toContain(message);
  });

  test("the staging admission binding is shared, not duplicated", () => {
    const gate = stagingBindings(committed).find(
      (binding) => binding.name === "INFERENCE_ADMISSION_GATES",
    );
    expect(gate?.script_name).toBe(committed.admission.name);
  });
});
