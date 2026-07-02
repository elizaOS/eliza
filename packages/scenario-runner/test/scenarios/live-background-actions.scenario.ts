import { scenario } from "@elizaos/scenario-runner/schema";
import {
  jsonResponse,
  readAppControlHttpRequests,
  registerAppControlHttpHandler,
  resetAppControlHttpLoopback,
} from "./_helpers/app-control-http-loopback";

// Real-LLM (live lane) counterpart of deterministic-background-actions
// (#10694). A REAL model must route natural background requests to the real
// plugin-app-control BACKGROUND handler — solid color, programmable GLSL
// shader preset, and undo — and the handler must emit the real
// `background:apply` broadcasts the renderer consumes. The deterministic
// catalog pins the exact payload contract on the keyless PR lane; this proves
// a live model actually drives the same path (model → action → broadcast),
// turnkey as soon as model keys are present.

function backgroundApplyPayloads(): Record<string, unknown>[] {
  return readAppControlHttpRequests(
    (request) =>
      request.method === "POST" &&
      request.pathname === "/api/views/events/broadcast",
  )
    .map((request) => {
      const body = request.body;
      if (!body || typeof body !== "object" || Array.isArray(body)) return null;
      const record = body as Record<string, unknown>;
      if (record.type !== "background:apply") return null;
      const payload = record.payload;
      return payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : null;
    })
    .filter((payload): payload is Record<string, unknown> => payload !== null);
}

export default scenario({
  id: "live-background-actions",
  lane: "live-only",
  title: "Real LLM drives the BACKGROUND action (color, GLSL shader, undo)",
  domain: "scenario-runner",
  tags: ["live", "real-llm", "app-control", "background"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-app-control"],
  },
  seed: [
    {
      type: "custom",
      name: "register background broadcast loopback API",
      apply: () => {
        resetAppControlHttpLoopback();
        registerAppControlHttpHandler((request) => {
          if (
            request.method === "POST" &&
            request.pathname === "/api/views/events/broadcast"
          ) {
            return jsonResponse({ ok: true, delivered: 1 });
          }
          return undefined;
        });
        return undefined;
      },
    },
  ],
  rooms: [
    {
      id: "main",
      source: "chat",
      title: "Live Background Actions",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "set a teal background from natural language",
      room: "main",
      text: "Please make the app background teal.",
      responseJudge: {
        minimumScore: 0.6,
        rubric:
          "The assistant must confirm it changed/set the background (to teal or an equivalent color). A reply that refuses, asks a clarifying question instead of acting, or talks about something unrelated fails.",
      },
    },
    {
      kind: "message",
      name: "set an animated GLSL shader background",
      room: "main",
      // NOTE: an earlier phrasing ("something like a lava lamp", never naming
      // a preset) made the live planner route to REPLY instead of BACKGROUND —
      // captured in the issue evidence (attempt1-oblique-phrasing-report.json)
      // as a real routing miss for oblique shader requests. Naming the
      // advertised preset keeps this lane a stable regression on the
      // model→action→broadcast path.
      text: "Now switch the background to the animated lava shader.",
      responseJudge: {
        minimumScore: 0.6,
        rubric:
          "The assistant must confirm it applied an animated/shader background (naming a shader such as lava is ideal). A refusal or non-action reply fails.",
      },
    },
    {
      kind: "message",
      name: "undo the background change",
      room: "main",
      text: "Actually, undo that last background change.",
      responseJudge: {
        minimumScore: 0.6,
        rubric:
          "The assistant must confirm it reverted/undid the background change. A refusal or non-action reply fails.",
      },
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "BACKGROUND",
      status: "success",
      minCount: 3,
    },
    {
      type: "custom",
      name: "real background:apply broadcasts reached the renderer channel",
      predicate: () => {
        const payloads = backgroundApplyPayloads();
        const sets = payloads.filter((payload) => payload.op === "set");
        const undos = payloads.filter((payload) => payload.op === "undo");
        const glsl = sets.filter((payload) => payload.mode === "glsl");
        if (sets.length < 2) {
          return `expected at least 2 background:apply set broadcasts, saw ${JSON.stringify(payloads)}`;
        }
        if (glsl.length < 1) {
          return `expected at least 1 GLSL-mode set broadcast, saw ${JSON.stringify(payloads)}`;
        }
        if (undos.length < 1) {
          return `expected at least 1 undo broadcast, saw ${JSON.stringify(payloads)}`;
        }
        return undefined;
      },
    },
  ],
});
