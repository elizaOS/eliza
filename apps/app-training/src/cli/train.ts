/**
 * Multi-backend training CLI.
 *
 * Usage:
 *   bun run train -- --backend {atropos|tinker|vertex} --dataset <path> \
 *       [--task {should_respond|context_routing|action_planner|response|media_description}]
 *
 * Vertex backend forwards to the existing vertex-tuning module. Atropos and
 * Tinker backends live in src/backends/. The CLI is intentionally a thin
 * dispatcher so each backend can evolve independently.
 */

import { parseArgs } from "node:util";
import { runAtroposBackend } from "../backends/atropos.js";
import { runTinkerBackend } from "../backends/tinker.js";
import {
	createTuningJob,
	normalizeVertexBaseModel,
	waitForTuningJob,
	type VertexTuningSlot,
} from "../core/vertex-tuning.js";

const ALLOWED_BACKENDS = new Set(["atropos", "tinker", "vertex"]);
const ALLOWED_TASKS = new Set([
	"should_respond",
	"context_routing",
	"action_planner",
	"response",
	"media_description",
]);

const HELP = `Usage:
  bun run train -- --backend {atropos|tinker|vertex} --dataset <path> [options]

Options:
  --backend NAME       atropos | tinker | vertex (required)
  --dataset PATH       Path to training JSONL file (required)
  --task NAME          should_respond | context_routing | action_planner | response | media_description
  --bin PATH           (atropos) Path to atropos CLI binary
  --project ID         (vertex) GCP project ID
  --bucket NAME        (vertex) GCS bucket
  --region NAME        (vertex) GCP region (default us-central1)
  --epochs N           (vertex) Training epochs
  --display-name NAME  (vertex) Tuned model display name
  --help               Show this help text
`;

interface ParsedTrainArgs {
	backend: "atropos" | "tinker" | "vertex";
	dataset: string;
	task?: VertexTuningSlot;
	bin?: string;
	project?: string;
	bucket?: string;
	region?: string;
	epochs?: number;
	displayName?: string;
}

export function parseTrainArgs(argv: string[]): ParsedTrainArgs | "help" {
	const { values } = parseArgs({
		args: argv,
		options: {
			backend: { type: "string" },
			dataset: { type: "string" },
			task: { type: "string" },
			bin: { type: "string" },
			project: { type: "string" },
			bucket: { type: "string" },
			region: { type: "string", default: "us-central1" },
			epochs: { type: "string" },
			"display-name": { type: "string" },
			help: { type: "boolean" },
		},
		allowPositionals: false,
	});
	if (values.help) return "help";

	const backend = values.backend?.trim();
	if (!backend || !ALLOWED_BACKENDS.has(backend)) {
		throw new Error(
			`--backend is required and must be one of: ${[...ALLOWED_BACKENDS].join(", ")}`,
		);
	}
	const dataset = values.dataset?.trim();
	if (!dataset) {
		throw new Error("--dataset <path> is required");
	}
	let task: VertexTuningSlot | undefined;
	if (values.task) {
		const t = values.task.trim();
		if (!ALLOWED_TASKS.has(t)) {
			throw new Error(
				`--task must be one of: ${[...ALLOWED_TASKS].join(", ")}`,
			);
		}
		task = t as VertexTuningSlot;
	}

	const epochsRaw = values.epochs;
	const epochs = epochsRaw ? Number(epochsRaw) : undefined;
	if (epochsRaw !== undefined && (!Number.isFinite(epochs) || (epochs ?? 0) < 1)) {
		throw new Error("--epochs must be a positive integer");
	}

	return {
		backend: backend as ParsedTrainArgs["backend"],
		dataset,
		task,
		bin: values.bin,
		project: values.project,
		bucket: values.bucket,
		region: values.region,
		epochs,
		displayName: values["display-name"],
	};
}

export async function runTrainCli(argv: string[]): Promise<number> {
	const parsed = parseTrainArgs(argv);
	if (parsed === "help") {
		process.stdout.write(HELP);
		return 0;
	}

	switch (parsed.backend) {
		case "atropos": {
			const result = await runAtroposBackend({
				datasetPath: parsed.dataset,
				task: parsed.task,
				bin: parsed.bin,
			});
			console.log(`[train] atropos staged dataset at ${result.stagedPath}`);
			if (result.invoked) {
				console.log(`[train] atropos exited with code ${result.exitCode}`);
				if (result.stderr) console.error(result.stderr);
				return result.exitCode ?? 0;
			}
			return 0;
		}
		case "tinker": {
			const result = await runTinkerBackend({
				datasetPath: parsed.dataset,
				task: parsed.task,
			});
			for (const note of result.notes) console.log(`[train] ${note}`);
			return result.invoked ? 0 : 1;
		}
		case "vertex": {
			if (!parsed.project || !parsed.bucket) {
				throw new Error(
					"vertex backend requires --project and --bucket",
				);
			}
			const slot: VertexTuningSlot = parsed.task ?? "should_respond";
			const job = await createTuningJob({
				projectId: parsed.project,
				region: parsed.region,
				gcsBucket: parsed.bucket,
				baseModel: normalizeVertexBaseModel(undefined, slot),
				trainingDataPath: parsed.dataset,
				displayName: parsed.displayName ?? `eliza-${slot}`,
				epochs: parsed.epochs,
			});
			console.log(`[train] vertex tuning job created: ${job.name}`);
			const final = await waitForTuningJob(job.name, {
				onPoll: (j) =>
					console.log(
						`[train] [${new Date().toISOString()}] state=${j.state}`,
					),
			});
			if (final.state !== "JOB_STATE_SUCCEEDED") {
				console.error(`[train] tuning failed: ${final.error?.message ?? "unknown"}`);
				return 1;
			}
			console.log(`[train] tuned model: ${final.tunedModelEndpointName ?? final.tunedModelDisplayName}`);
			return 0;
		}
		default: {
			// Unreachable thanks to the ALLOWED_BACKENDS guard above.
			throw new Error(`Unknown backend: ${parsed.backend}`);
		}
	}
}

if (
	import.meta.url ===
	`file://${process.argv[1] ? new URL(`file://${process.argv[1]}`).pathname : ""}`
) {
	runTrainCli(process.argv.slice(2))
		.then((code) => process.exit(code))
		.catch((err) => {
			console.error(err instanceof Error ? err.message : String(err));
			process.exit(1);
		});
}
