/**
 * Loading and orchestration for the shipped walkthrough definitions. Definitions
 * are data under `walkthroughs/*.json`; this module discovers them, validates
 * each through the schema, and runs the driver → normalize → ingest pipeline for
 * one definition. The shipped set targets the self-contained dashboard fixture
 * (served locally) so `element` and `feature` lanes run with zero app boot; a
 * definition marked `requiresApp` runs only when the caller supplies the real
 * app's baseUrl.
 *
 * The two seams — where definitions live, and where the fixture lives — are the
 * only filesystem knowledge here; the driver, normalizer, and ingestor stay
 * pure and reusable for any origin.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { EvidenceBundle } from "../bundle.ts";
import { EvidenceError } from "../errors.ts";
import { type RunWalkthroughOptions, runWalkthrough } from "./driver.ts";
import { serveFixture } from "./fixture-server.ts";
import { type IngestVideoResult, ingestVideo } from "./ingest.ts";
import {
  parseWalkthroughDef,
  type WalkthroughDef,
} from "./walkthrough-schema.ts";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
/** Directory holding the shipped `*.json` walkthrough definitions. */
export const WALKTHROUGHS_DIR = path.join(moduleDir, "walkthroughs");
/** The self-contained dashboard fixture the shipped definitions drive. */
export const FIXTURE_DIR = path.join(moduleDir, "fixture");
const FIXTURE_INDEX = "dashboard.html";

/** Load and validate one definition file (`.json`). Throws typed on invalid. */
export function loadWalkthroughDef(file: string): WalkthroughDef {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    // error-policy:J2 context-adding rethrow — a named-but-missing definition
    // is a caller error, not an empty walkthrough.
    throw new EvidenceError(`walkthrough definition not readable: ${file}`, {
      code: "WALKTHROUGH_DEF_MISSING",
      cause: error,
      context: { file },
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    // error-policy:J3 untrusted disk input — malformed JSON is a typed invalid.
    throw new EvidenceError(
      `walkthrough definition is not valid JSON: ${file}`,
      {
        code: "WALKTHROUGH_DEF_INVALID",
        cause: error,
        context: { file },
      },
    );
  }
  return parseWalkthroughDef(parsed, file);
}

/** Every shipped definition, sorted by slug for deterministic run order. */
export function loadAllWalkthroughDefs(): {
  def: WalkthroughDef;
  file: string;
}[] {
  return fs
    .readdirSync(WALKTHROUGHS_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const file = path.join(WALKTHROUGHS_DIR, name);
      return { def: loadWalkthroughDef(file), file };
    });
}

/** Options for {@link runAndIngestWalkthrough}. */
export interface RunAndIngestOptions {
  /** Scratch dir for the driver's raw artifacts (video/screenshots/snapshots). */
  out: string;
  /**
   * Base URL to drive. When omitted, the shipped fixture is served locally and
   * used — unless the definition is `requiresApp`, which then errors.
   */
  baseUrl?: string;
  /** Producer id recorded on the ingested video's source. */
  source?: string;
  /** Injectable browser + viewport + timeout + dwell, forwarded to the driver. */
  driver?: Pick<
    RunWalkthroughOptions,
    "browser" | "viewport" | "timeoutMs" | "stepPauseMs"
  >;
}

/** Result of running one walkthrough and ingesting its video into a bundle. */
export interface RunAndIngestResult {
  slug: string;
  ingest: IngestVideoResult;
  /** Absolute paths of the per-step screenshots the driver captured. */
  screenshots: string[];
  /** Absolute paths of the per-step ARIA snapshots the driver captured. */
  ariaSnapshots: string[];
  /** Absolute path of the driver's steps-log JSON. */
  stepsLog: string;
  /** Number of steps the driver executed. */
  stepCount: number;
}

/**
 * Run one walkthrough definition and ingest its video (normalized + keyframe
 * analyzed) into `bundle`, plus its screenshots (as `screenshot` artifacts) and
 * ARIA snapshots (as `html-tree` artifacts) and steps-log (as a `report`). When
 * `baseUrl` is omitted the shipped fixture is served locally for the duration of
 * the run.
 */
export async function runAndIngestWalkthrough(
  def: WalkthroughDef,
  bundle: EvidenceBundle,
  options: RunAndIngestOptions,
): Promise<RunAndIngestResult> {
  const source = options.source ?? "walkthrough-driver";
  let baseUrl = options.baseUrl;
  let fixture: Awaited<ReturnType<typeof serveFixture>> | undefined;
  if (baseUrl === undefined && !def.requiresApp) {
    fixture = await serveFixture(FIXTURE_DIR, FIXTURE_INDEX);
    baseUrl = fixture.baseUrl;
  }
  try {
    const run = await runWalkthrough(def, {
      out: options.out,
      baseUrl,
      ...options.driver,
    });
    const ingest = await ingestVideo(bundle, run.video, {
      granularity: def.granularity,
      slug: def.slug,
      source,
      producedBy: "walkthrough-driver",
      ...(def.granularity === "walkthrough" || def.granularity === "feature"
        ? { lane: "e2e" }
        : {}),
    });
    // Screenshots, snapshots, and the steps-log ride into the bundle alongside
    // the video so the walkthrough is fully self-describing evidence. The
    // driver's basenames already carry the zero-padded step index, so they are
    // used as-is — re-prefixing would double-index ("00-03-click.png").
    for (const shot of run.screenshots) {
      await bundle.addArtifact(shot, {
        kind: "screenshot",
        source,
        producedBy: "walkthrough-driver",
        bundlePath: `video/${def.granularity}s/${def.slug}/steps/${path.basename(shot)}`,
      });
    }
    for (const snap of run.ariaSnapshots) {
      await bundle.addArtifact(snap, {
        kind: "html-tree",
        source,
        producedBy: "walkthrough-driver",
        bundlePath: `html-trees/${def.slug}/${path.basename(snap)}`,
      });
    }
    await bundle.addArtifact(run.stepsLog, {
      kind: "report",
      source,
      producedBy: "walkthrough-driver",
      bundlePath: `video/${def.granularity}s/${def.slug}/steps.json`,
    });
    return {
      slug: def.slug,
      ingest,
      screenshots: run.screenshots,
      ariaSnapshots: run.ariaSnapshots,
      stepsLog: run.stepsLog,
      stepCount: run.steps.length,
    };
  } finally {
    if (fixture !== undefined) await fixture.stop();
  }
}
