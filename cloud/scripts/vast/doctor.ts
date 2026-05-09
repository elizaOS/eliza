import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cloudRoot = join(__dirname, "..", "..");
const vastPyworkerDir = join(cloudRoot, "services", "vast-pyworker");
const manifestDir = join(vastPyworkerDir, "manifests");

const turboQuantDtypes = new Set([
  "turboquant_k8v4",
  "turboquant_4bit_nc",
  "turboquant_k3v4_nc",
  "turboquant_3bit_nc",
]);

interface Manifest {
  label?: string;
  model?: string;
  model_repo?: string;
  model_alias?: string;
  served_model_name?: string;
  image?: string;
  port?: number;
  tensor_parallel_size?: number;
  max_model_len?: number;
  weight_quantization?: string;
  kv_cache_dtype?: string;
  enable_turboquant?: boolean;
  turboquant_preset?: string;
  additional_config?: Record<string, unknown>;
  onstart_script?: string;
  vast_template_env?: Record<string, string>;
}

function fail(message: string): never {
  throw new Error(message);
}

function assert(condition: unknown, message: string): void {
  if (!condition) fail(message);
}

function readManifest(path: string): Manifest {
  return JSON.parse(readFileSync(path, "utf8")) as Manifest;
}

function validateManifest(file: string): void {
  const path = join(manifestDir, file);
  const manifest = readManifest(path);
  const prefix = `${file}:`;

  assert(manifest.label, `${prefix} missing label`);
  assert(manifest.model || manifest.model_repo, `${prefix} missing model/model_repo`);
  assert(manifest.model_alias?.startsWith("vast/"), `${prefix} model_alias must be a vast/* id`);
  assert(manifest.served_model_name, `${prefix} missing served_model_name`);
  assert(manifest.image?.startsWith("vllm/"), `${prefix} vLLM manifest should use a vllm image`);
  assert(manifest.onstart_script === "onstart-vllm.sh", `${prefix} must use onstart-vllm.sh`);
  assert(Number.isInteger(manifest.port) && manifest.port > 0, `${prefix} invalid port`);
  assert(
    Number.isInteger(manifest.tensor_parallel_size) && manifest.tensor_parallel_size > 0,
    `${prefix} invalid tensor_parallel_size`,
  );
  assert(
    Number.isInteger(manifest.max_model_len) && manifest.max_model_len > 0,
    `${prefix} invalid max_model_len`,
  );
  assert(manifest.vast_template_env?.MODEL_REPO, `${prefix} missing vast_template_env.MODEL_REPO`);
  assert(
    manifest.vast_template_env?.MODEL_ALIAS,
    `${prefix} missing vast_template_env.MODEL_ALIAS`,
  );

  if (manifest.enable_turboquant) {
    assert(
      manifest.kv_cache_dtype && turboQuantDtypes.has(manifest.kv_cache_dtype),
      `${prefix} enable_turboquant requires a known TurboQuant kv_cache_dtype`,
    );
    assert(
      manifest.turboquant_preset === "quality" || manifest.turboquant_preset === "4bit",
      `${prefix} turboquant_preset should be quality or 4bit`,
    );
    if (manifest.turboquant_preset === "quality") {
      assert(
        manifest.kv_cache_dtype === "turboquant_k8v4",
        `${prefix} quality preset must default to turboquant_k8v4`,
      );
    }
  }

  assert(
    !manifest.additional_config || manifest.additional_config.qjl !== true,
    `${prefix} QJL must not be enabled in manifests; use VLLM_EXPERIMENTAL_QJL with benchmark gate`,
  );
}

function validateRuntimeScripts(): void {
  const vllmOnstart = readFileSync(join(vastPyworkerDir, "onstart-vllm.sh"), "utf8");
  assert(
    vllmOnstart.includes("VLLM_QJL_BENCHMARK_GATE=passed"),
    "onstart-vllm.sh must benchmark-gate experimental QJL",
  );
  assert(
    vllmOnstart.includes("turboquant_k8v4") && vllmOnstart.includes("turboquant_4bit_nc"),
    "onstart-vllm.sh must expose quality and 4bit TurboQuant presets",
  );
  assert(
    vllmOnstart.includes("--speculative-config") && vllmOnstart.includes('"method": "dflash"'),
    "onstart-vllm.sh must expose vLLM speculative/DFlash config",
  );
  assert(
    vllmOnstart.includes("VLLM_METAL_ADDITIONAL_CONFIG_JSON"),
    "onstart-vllm.sh must expose vllm-metal additional config",
  );

  const upsert = readFileSync(join(__dirname, "upsert-template.ts"), "utf8");
  assert(
    upsert.includes('VAST_RUNTIME", "llama"'),
    "upsert-template.ts must keep llama as default runtime",
  );
  assert(
    upsert.includes("MILADY_VAST_MANIFEST_JSON"),
    "upsert-template.ts must inline vLLM manifest JSON",
  );
}

function main(): void {
  const manifests = readdirSync(manifestDir)
    .filter((file) => file.endsWith(".json"))
    .sort();
  assert(manifests.length > 0, "no Vast manifests found");
  for (const manifest of manifests) validateManifest(manifest);
  validateRuntimeScripts();
  console.log(`[vast:doctor] ok (${manifests.length} manifests)`);
}

main();
