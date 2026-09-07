/**
 * Exercises journal privacy and stable source/process admission for the staging
 * diagnostic using hostile input and deterministic read-boundary responses.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  collectDiagnostic,
  summarizeHealthFrames,
  summarizeImage,
  summarizeJournal,
} from "./staging-worker-diagnostic.mjs";

function consoleFrame(containerName, diagnostics) {
  const context = {
    containerName,
    nodeId: "private-node.invalid",
    diagnostics,
  };
  const result = spawnSync(
    "bun",
    [
      "-e",
      `console.warn("[docker-sandbox] Health timeout diagnostics", ${JSON.stringify(context)})`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0);
  return result.stderr.trimEnd();
}

// Reproduces exactly how the production worker logs the health-timeout context:
// the object is passed through the real core redactor (redactLogArgs) and
// rendered by Node's console sink, which prints the null-prototype clone with a
// distinct header, single-quoted values, and multiline strings concatenated over
// `'part\n' +` continuation lines. The frame is generated from the real redactor
// so a future format drift in either producer or console is caught here rather
// than in a hand-written literal.
function nodeFrame(containerName, diagnostics) {
  const context = {
    containerName,
    nodeId: "private-node.invalid",
    diagnostics,
  };
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { redactLogArgs } from "@elizaos/core/edge";\nconsole.warn(...redactLogArgs([${JSON.stringify("[docker-sandbox] Health timeout diagnostics")}, ${JSON.stringify(context)}]));`,
    ],
    { encoding: "utf8", cwd: new URL(".", import.meta.url) },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stderr.trimEnd();
}

test("real Bun console frames retain health facts while removing identifiers and log text", () => {
  const name = "agent-11111111-1111-4111-8111-111111111111";
  const digest = createHash("sha256").update(name).digest("hex");
  const frame = consoleFrame(
    name,
    "--- inspect ---\nstate=exited health=unhealthy exit=1 error=private-secret\n--- authkey marker ---\nauthkey-marker=absent\n--- logs ---\nCannot find module private-module.invalid; token=private-secret\n",
  );
  for (const messages of [[frame], frame.split("\n")]) {
    const result = summarizeHealthFrames(messages, digest);
    assert.equal(result.all.frames, 1);
    assert.equal(result.target.frames, 1);
    assert.equal(result.target.observations[0].containerState, "exited");
    assert.equal(result.target.observations[0].exitCode, 1);
    assert.equal(
      result.target.observations[0].bootSignals.module_resolution,
      true,
    );
    assert.equal(JSON.stringify(result).includes("private"), false);
    assert.equal(JSON.stringify(result).includes(name), false);
  }
});

test("real Node redactor frames decode the same health facts the Bun path extracts while removing identifiers and log text", () => {
  const name = "agent-11111111-1111-4111-8111-111111111111";
  const digest = createHash("sha256").update(name).digest("hex");
  const frame = nodeFrame(
    name,
    "--- inspect ---\nstate=exited health=unhealthy exit=1 error=private-secret\n--- authkey marker ---\nauthkey-marker=absent\n--- logs ---\nCannot find module private-module.invalid; token=private-secret\n",
  );
  // The Node header and single quotes must be present, proving the frame is the
  // real production shape and not the Bun rendering.
  assert.match(frame, /\[Object: null prototype\] \{/);
  assert.match(frame, /diagnostics: '--- inspect ---\\n' \+/);
  for (const messages of [[frame], frame.split("\n")]) {
    const result = summarizeHealthFrames(messages, digest);
    assert.equal(result.all.frames, 1);
    assert.equal(result.all.malformedFrames, 0);
    assert.equal(result.target.frames, 1);
    const observation = result.target.observations[0];
    assert.equal(observation.containerState, "exited");
    assert.equal(observation.health, "unhealthy");
    assert.equal(observation.exitCode, 1);
    assert.equal(observation.inspectErrorPresent, true);
    assert.equal(observation.authKeyMarker, "absent");
    assert.equal(observation.diagnosticsTruncated, false);
    assert.equal(observation.bootSignals.module_resolution, true);
    assert.equal(observation.bootSignals.out_of_memory, false);
    assert.equal(JSON.stringify(result).includes("private"), false);
    assert.equal(JSON.stringify(result).includes(name), false);
  }
});

test("a Node frame whose diagnostics exceeds the console string cap still yields the surviving inspect facts flagged as truncated", () => {
  const name = "agent-22222222-2222-4222-8222-222222222222";
  const digest = createHash("sha256").update(name).digest("hex");
  let diagnostics =
    "--- inspect ---\nstate=exited health=unhealthy exit=137 error=\n--- authkey marker ---\nauthkey-marker=present\n--- logs ---\nCannot find module private-early.invalid\n";
  // Push well past Node's 10000-character console string cap so the tail (and
  // any late signal in it) is dropped by the sink, not by our parser.
  for (let index = 0; index < 300; index += 1) {
    diagnostics += `logline ${index} routine private-chatter padding padding padding\n`;
  }
  diagnostics += "OutOfMemory private-late-signal\n";
  const frame = nodeFrame(name, diagnostics);
  assert.match(frame, /\.\.\. [0-9]+ more characters$/m);
  const result = summarizeHealthFrames([frame], digest);
  assert.equal(result.all.frames, 1);
  assert.equal(result.target.frames, 1);
  const observation = result.target.observations[0];
  assert.equal(observation.containerState, "exited");
  assert.equal(observation.exitCode, 137);
  assert.equal(observation.authKeyMarker, "present");
  assert.equal(observation.diagnosticsTruncated, true);
  // The early boot signal survived; the truncated-away tail signal is honestly
  // absent rather than fabricated.
  assert.equal(observation.bootSignals.module_resolution, true);
  assert.equal(observation.bootSignals.out_of_memory, false);
  assert.equal(JSON.stringify(result).includes("private"), false);
  assert.equal(JSON.stringify(result).includes(name), false);
});

test("Node frames carrying control-character and alternate-quote escapes decode without evaluating the literal", () => {
  const name = "agent-44444444-4444-4444-8444-444444444444";
  const digest = createHash("sha256").update(name).digest("hex");
  // Node renders control characters as \xNN and switches to double quotes for a
  // line containing a single quote; both must be decoded, never eval'd.
  const frame = nodeFrame(
    name,
    "--- inspect ---\nstate=exited health=unhealthy exit=2 error=tab\there\u0007bell\n--- authkey marker ---\nauthkey-marker=absent\n--- logs ---\nquote='single-private' and value here\n",
  );
  assert.match(frame, /\\x07/);
  assert.match(frame, /"quote='single-private'/);
  const result = summarizeHealthFrames([frame], digest);
  assert.equal(result.all.frames, 1);
  assert.equal(result.all.malformedFrames, 0);
  assert.equal(result.target.frames, 1);
  assert.equal(result.target.observations[0].exitCode, 2);
  assert.equal(result.target.observations[0].inspectErrorPresent, true);
  assert.equal(JSON.stringify(result).includes("private"), false);
  assert.equal(JSON.stringify(result).includes(name), false);
});

test("Node frames whose diagnostics render with backtick delimiters still decode their health facts", () => {
  const name = "agent-55555555-5555-4555-8555-555555555555";
  const digest = createHash("sha256").update(name).digest("hex");
  // A diagnostics line containing both a single and a double quote (but no
  // backtick and no `${`) forces Node's util.inspect to select backtick
  // delimiters for that continuation line. The frame must still decode instead
  // of being discarded as malformed along with its preceding inspect facts.
  const frame = nodeFrame(
    name,
    "--- inspect ---\nstate=exited health=unhealthy exit=1 error=private-secret\n--- authkey marker ---\nauthkey-marker=absent\n--- logs ---\noption 'mode' received \"invalid\"; Cannot find module private-module.invalid\n",
  );
  // Prove the rendered frame really uses the backtick form this fix targets.
  assert.match(frame, /`[^`]*'mode'[^`]*"invalid"[^`]*`/);
  const result = summarizeHealthFrames([frame], digest);
  assert.equal(result.all.frames, 1);
  assert.equal(result.all.malformedFrames, 0);
  assert.equal(result.target.frames, 1);
  const observation = result.target.observations[0];
  assert.equal(observation.containerState, "exited");
  assert.equal(observation.exitCode, 1);
  assert.equal(observation.inspectErrorPresent, true);
  assert.equal(observation.authKeyMarker, "absent");
  assert.equal(observation.bootSignals.module_resolution, true);
  assert.equal(JSON.stringify(result).includes("private"), false);
  assert.equal(JSON.stringify(result).includes(name), false);
});

test("malformed, interleaved, and incomplete Node frames never certify a target", () => {
  const name = "agent-33333333-3333-4333-8333-333333333333";
  const digest = createHash("sha256").update(name).digest("hex");
  const frame = nodeFrame(
    name,
    "--- inspect ---\nstate=running health=healthy exit=0 error=\n--- authkey marker ---\nauthkey-marker=present\n--- logs ---\n",
  );
  // A non-target digest decodes the frame but attributes nothing to the target.
  const otherDigest = createHash("sha256").update("agent-other").digest("hex");
  const unmatched = summarizeHealthFrames([frame], otherDigest);
  assert.equal(unmatched.all.frames, 1);
  assert.equal(unmatched.target.frames, 0);

  const lines = frame.split("\n");
  const incomplete = summarizeHealthFrames(lines.slice(0, -1), digest);
  assert.equal(incomplete.all.frames, 0);
  assert.equal(incomplete.all.malformedFrames, 1);
  assert.equal(incomplete.target.frames, 0);

  const interleaved = summarizeHealthFrames(
    [
      ...lines.slice(0, 3),
      "[another subsystem] unrelated private message",
      ...lines.slice(3),
    ],
    digest,
  );
  assert.equal(interleaved.all.frames, 0);
  assert.equal(interleaved.all.malformedFrames, 1);
  assert.equal(interleaved.target.frames, 0);
  assert.equal(JSON.stringify(interleaved).includes("private"), false);
});

test("missing containers and unsupported inspect output remain distinct from healthy state", () => {
  const frames = [
    consoleFrame(
      "agent-one",
      "--- inspect ---\nError: No such object: agent-one\n--- authkey marker ---\nauthkey-marker=unknown\n--- logs ---\n",
    ),
    consoleFrame(
      "agent-two",
      "--- inspect ---\nprivate unexpected output\n--- authkey marker ---\n",
    ),
  ];
  const result = summarizeHealthFrames(frames);
  assert.equal(result.all.observations[0].containerState, "missing");
  assert.equal(result.all.observations[1].containerState, "unavailable");
  assert.equal(result.all.observations[1].exitCode, null);
  assert.equal(result.all.observations[1].bootSignals, null);
  assert.equal(result.target, null);
});

test("container log text cannot replace the auth marker or hide later boot signals", () => {
  const frame = consoleFrame(
    "agent-one",
    "--- inspect ---\nstate=exited health=unhealthy exit=137 error=\n--- authkey marker ---\nauthkey-marker=absent\n--- ports ---\n--- logs ---\nauthkey-marker=present\n--- logs ---\nOutOfMemory private-data\n",
  );
  const result = summarizeHealthFrames([frame]);
  assert.equal(result.all.observations[0].authKeyMarker, "absent");
  assert.equal(result.all.observations[0].bootSignals.out_of_memory, true);
});

test("unmatched targets, incomplete frames and unexpected interleaving never certify a target", () => {
  const frame = consoleFrame(
    "agent-one",
    "--- inspect ---\nstate=running health=healthy exit=0 error=\n--- authkey marker ---\n",
  );
  const digest = createHash("sha256").update("agent-other").digest("hex");
  assert.equal(summarizeHealthFrames([frame], digest).target.frames, 0);
  const lines = frame.split("\n");
  const incomplete = summarizeHealthFrames(lines.slice(0, -1), digest);
  assert.equal(incomplete.all.frames, 0);
  assert.equal(incomplete.all.malformedFrames, 1);
  const interleaved = summarizeHealthFrames(
    [
      ...lines.slice(0, 2),
      "[another subsystem] unrelated message",
      ...lines.slice(2),
    ],
    digest,
  );
  assert.equal(interleaved.all.frames, 0);
  assert.equal(interleaved.all.malformedFrames, 1);
});

test("embedded timeout messages cannot attribute another container's diagnostics to a target", () => {
  const digest = createHash("sha256").update("agent-two").digest("hex");
  const timeouts = [
    "[docker-sandbox] Docker health check timed out after 60s for agent-two on private-host",
    "[docker-sandbox] Tailnet health check timed out after 60s for agent-two (http://private-host/health)",
  ];
  const frame = consoleFrame(
    "agent-one",
    `--- inspect ---\nstate=exited health=unhealthy exit=1 error=\n--- logs ---\n${timeouts.join("\n")}\n`,
  );
  for (const messages of [
    [frame],
    frame.split("\n"),
    timeouts.map((value) => `untrusted: ${value}`),
  ]) {
    const journal = messages
      .map((MESSAGE) => JSON.stringify({ MESSAGE }))
      .join("\n");
    const result = summarizeJournal(journal, digest);
    assert.deepEqual(result.targetHealthTimeouts, { docker: 0, tailnet: 0 });
    assert.equal(result.healthTimeouts.target.frames, 0);
  }
  const genuine = summarizeJournal(
    timeouts.map((MESSAGE) => JSON.stringify({ MESSAGE })).join("\n"),
    digest,
  );
  assert.deepEqual(genuine.targetHealthTimeouts, { docker: 1, tailnet: 1 });
});

test("invalid target correlation digest rejects before privileged reads", () => {
  let called = false;
  assert.throws(
    () =>
      collectDiagnostic(
        SHA,
        () => {
          called = true;
        },
        () => environment,
        "$(private-command)",
      ),
    /target_digest_invalid/,
  );
  assert.equal(called, false);
});

const SHA = "a".repeat(40);
const DIGEST = "b".repeat(64);
const PRIVATE = "private-token@example.invalid/agent-123";
const environment = `PASSWORD=${PRIVATE}\0ELIZA_AGENT_IMAGE=ghcr.io/elizaos/eliza-demo@sha256:${DIGEST}\0`;
const journal = [
  {
    MESSAGE: `[docker-sandbox] Docker health check timed out for ${PRIVATE}`,
    HOSTNAME: PRIVATE,
  },
  {
    MESSAGE: `[docker-sandbox] Container failed mesh join: headscale auth key expired/rejected ${PRIVATE}`,
  },
  { MESSAGE: PRIVATE },
]
  .map(JSON.stringify)
  .join("\n");

function hostReads({ changedSource = false, changedPid = false } = {}) {
  let sourceReads = 0;
  let pidReads = 0;
  return (file, args) => {
    if (file === "/usr/bin/git")
      return changedSource && sourceReads++ > 0 ? "c".repeat(40) : SHA;
    if (file === "/usr/bin/sudo") return journal;
    if (file === "/usr/bin/systemctl" && args.includes("--property=MainPID"))
      return changedPid && pidReads++ > 0 ? "456" : "123";
    if (
      file === "/usr/bin/systemctl" &&
      args.includes("--property=ActiveState")
    )
      return "active";
    throw new Error("unexpected command");
  };
}

test("host reads produce only public image facts and worker-level category counts", () => {
  const result = collectDiagnostic(SHA, hostReads(), (pid) => {
    assert.equal(pid, "123");
    return environment;
  });
  assert.equal(result.journal.counts.docker_health_timeout, 1);
  assert.equal(result.journal.counts.mesh_auth_rejected, 1);
  assert.equal(result.journal.records, 3);
  assert.equal(result.image.digest, `sha256:${DIGEST}`);
  assert.equal(JSON.stringify(result).includes(PRIVATE), false);
  assert.equal(JSON.stringify(result).includes("HOSTNAME"), false);
});

test("invalid expected source rejects before any host read", () => {
  let called = false;
  assert.throws(
    () =>
      collectDiagnostic("$(arbitrary-command)", () => {
        called = true;
      }),
    /expected_source_invalid/,
  );
  assert.equal(called, false);
});

test("source or process replacement during collection prevents certification", () => {
  for (const mutation of [{ changedSource: true }, { changedPid: true }]) {
    assert.throws(
      () => collectDiagnostic(SHA, hostReads(mutation), () => environment),
      /worker_changed_during_read/,
    );
  }
});

test("private or malformed image references never escape the boundary", () => {
  for (const value of [
    PRIVATE,
    `ghcr.io/elizaos/eliza-demo@sha256:${DIGEST}\n${PRIVATE}`,
  ]) {
    assert.deepEqual(summarizeImage(`ELIZA_AGENT_IMAGE=${value}\0`), {
      family: "other",
      digest: null,
    });
  }
  assert.throws(
    () => summarizeImage("PASSWORD=hidden\0"),
    /image_pin_missing_or_ambiguous/,
  );
  assert.throws(
    () => summarizeImage(environment + environment),
    /image_pin_missing_or_ambiguous/,
  );
});

test("malformed journal records cannot become healthy-looking empty observations", () => {
  assert.throws(() => summarizeJournal('{"MESSAGE":'), SyntaxError);
  assert.throws(
    () => summarizeJournal('{"MESSAGE":[1,2]}'),
    /journal_format_invalid/,
  );
  assert.equal(summarizeJournal("").records, 0);
});

test("stdin CLI rejects hostile source input without emitting it or invoking host reads", () => {
  const source = readFileSync(
    new URL("./staging-worker-diagnostic.mjs", import.meta.url),
    "utf8",
  );
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-", PRIVATE],
    { input: source, encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /read failed; no private data emitted/);
  assert.equal(result.stderr.includes(PRIVATE), false);
});
