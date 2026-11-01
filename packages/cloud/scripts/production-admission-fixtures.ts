/**
 * A fake Cloudflare account for the production admission tests: the live
 * state after each transfer phase, served through the readback's reader
 * shape. No network.
 */
import { createHash } from "node:crypto";
import {
  type CloudflareRead,
  KNOWN_EXTERNAL_CONSUMERS,
  LIVE_PHASES,
  type LivePhase,
  PRODUCTION_ADMISSION_NAMESPACE_ID as NPROD,
} from "./production-admission-readback.ts";

export const API = "eliza-cloud-api-prod";
export const TARGET = "eliza-cloud-admission-prod";
export const DIAG = KNOWN_EXTERNAL_CONSUMERS[0].script;
export const GATE = "InferenceAdmissionGate";

export type Binding = Record<string, unknown>;
export interface Worker {
  version: string;
  bindings: Binding[];
  classes?: string[] | null;
  // A second version in the serving deployment (a gradual rollout).
  split?: { version: string; percentage: number; bindings: Binding[] };
  // The latest uploaded version's bindings, when it is not the one serving.
  settings?: Binding[];
}
export interface World {
  namespaces: Record<string, unknown>[];
  namespacePage?: (
    page: number,
    items: Record<string, unknown>[],
  ) => Awaited<ReturnType<CloudflareRead>>;
  scripts: Record<string, Worker>;
  scriptList?: () => Awaited<ReturnType<CloudflareRead>>;
  objects: { id: string; hasStoredData: boolean }[];
  objectPageSize: number;
}

export const gate = (scriptName?: string): Binding => ({
  name: "INFERENCE_ADMISSION_GATES",
  type: "durable_object_namespace",
  class_name: GATE,
  namespace_id: NPROD,
  ...(scriptName ? { script_name: scriptName } : {}),
});
export const text = (name: string, value: string): Binding => ({
  name,
  type: "plain_text",
  text: value,
});
const flags = () => [
  text("ENVIRONMENT", "production"),
  text("INFERENCE_STRONG_REVOCATION_ENABLED", "false"),
  text("VOICE_SPEECH_RELAY_ENABLED", "true"),
];
export const setText = (bindings: Binding[], name: string, value: string) => {
  bindings[bindings.findIndex((binding) => binding.name === name)] = text(
    name,
    value,
  );
};
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const hex = (value: number, length: number) =>
  value.toString(16).padStart(length, "0");

/** The live state after `phase`. */
export function world(phase: LivePhase): World {
  const live = LIVE_PHASES[phase];
  const scripts: World["scripts"] = {
    [API]: {
      version: "api-v1",
      classes: [GATE, "SpeechRelayCoordinator"],
      bindings: [
        gate(live.apiGate === "target" ? TARGET : undefined),
        ...flags(),
        text("ELIZA_DEPLOY_COMMIT", "a".repeat(40)),
      ],
    },
    [DIAG]: {
      version: "diag-v1",
      bindings: [
        {
          name: "PRODUCTION",
          type: "durable_object_namespace",
          class_name: GATE,
          namespace_id: NPROD,
          script_name: API,
        },
      ],
    },
    // Staging binds its own namespace of the same class; it is not a consumer.
    "eliza-cloud-admission-staging": {
      version: "staging-v1",
      bindings: [{ ...gate(), namespace_id: "f".repeat(32) }],
    },
  };
  if (live.target !== "absent")
    scripts[TARGET] = {
      version: "target-v1",
      classes: [GATE],
      bindings: [
        ...(live.target === "bound" ? [gate()] : []),
        {
          name: "INFERENCE_RECOVERY_SERVICE",
          type: "service",
          service: API,
          entrypoint: "InferenceRecoveryService",
        },
        ...flags(),
        text("ELIZA_DEPLOY_COMMIT", "b".repeat(40)),
      ],
    };
  return {
    namespaces: [
      {
        id: NPROD,
        class: GATE,
        script: live.owner === "api" ? API : TARGET,
        use_sqlite: true,
      },
      ...Array.from({ length: 120 }, (_, index) => ({
        id: hex(index, 32),
        class: "OtherClass",
        script: `worker-${index}`,
        use_sqlite: true,
      })),
    ],
    scripts,
    objects: Array.from({ length: 30 }, (_, index) => ({
      id: hex(index, 64),
      hasStoredData: index % 3 !== 0,
    })),
    objectPageSize: 7,
  };
}

export function reader(state: World, calls: string[] = []): CloudflareRead {
  return async (path) => {
    calls.push(path);
    const url = new URL(path, "https://cloudflare.invalid");
    if (url.pathname === "/workers/durable_objects/namespaces") {
      const page = Number(url.searchParams.get("page"));
      const size = Number(url.searchParams.get("per_page"));
      const items = state.namespaces.slice((page - 1) * size, page * size);
      return (
        state.namespacePage?.(page, items) ?? {
          result: items,
          result_info: {
            page,
            per_page: size,
            count: items.length,
            total_count: state.namespaces.length,
          },
        }
      );
    }
    if (
      url.pathname === `/workers/durable_objects/namespaces/${NPROD}/objects`
    ) {
      const start = Number(url.searchParams.get("cursor") ?? 0);
      const items = state.objects.slice(start, start + state.objectPageSize);
      const next = start + items.length;
      return {
        result: items,
        result_info: {
          count: items.length,
          ...(next < state.objects.length ? { cursor: String(next) } : {}),
        },
      };
    }
    if (url.pathname === "/workers/scripts")
      return (
        state.scriptList?.() ?? {
          result: Object.keys(state.scripts).map((id) => ({ id })),
        }
      );
    const match = url.pathname.match(
      /^\/workers\/scripts\/([^/]+)\/(deployments|settings|versions\/(.+))$/,
    );
    const worker = match && state.scripts[match[1]];
    if (!match || !worker)
      throw new Error(`Cloudflare readback failed (HTTP 404): ${path}`);
    if (match[2] === "deployments")
      return {
        result: {
          deployments: [
            {
              created_on: "2026-11-01T00:00:00Z",
              versions: [
                {
                  version_id: worker.version,
                  percentage: 100 - (worker.split?.percentage ?? 0),
                },
                ...(worker.split
                  ? [
                      {
                        version_id: worker.split.version,
                        percentage: worker.split.percentage,
                      },
                    ]
                  : []),
              ],
            },
          ],
        },
      };
    if (match[2] === "settings")
      return { result: { bindings: worker.settings ?? worker.bindings } };
    const bindings =
      match[3] === worker.version
        ? worker.bindings
        : match[3] === worker.split?.version
          ? worker.split.bindings
          : undefined;
    return {
      result: bindings && {
        id: match[3],
        resources: {
          bindings,
          script:
            worker.classes === null
              ? {}
              : {
                  named_handlers: (worker.classes ?? []).map((name) => ({
                    name,
                    handlers: ["class"],
                  })),
                },
        },
      },
    };
  };
}
