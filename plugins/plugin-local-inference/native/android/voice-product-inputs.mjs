/** Product-owned language selection for the shared Android voice producer and consumer. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function voiceProductInputs(inputs, requested) {
  const defaults = ["en", ...(inputs.spanish?.enabled === true ? ["es"] : [])];
  const languages = requested ?? defaults;
  if (!Array.isArray(languages) || !languages.includes("en") ||
      new Set(languages).size !== languages.length ||
      languages.some(language => !["en", "es"].includes(language))) {
    throw new Error("Voice languages must contain English and optionally Spanish, without duplicates");
  }
  const spanish = languages.includes("es");
  if (spanish && inputs.spanish?.enabled !== true) throw new Error("Spanish is not enabled by the pinned inputs");
  const spanishData = ["es_dict", "lang/roa/es"];
  if (!Array.isArray(inputs.espeak?.data) || !Array.isArray(spanishData) ||
      spanishData.some(file => typeof file !== "string" || (spanish && !inputs.espeak.data.includes(file)))) {
    throw new Error("Spanish eSpeak data must name pinned input files");
  }
  return {
    languages: ["en", ...(spanish ? ["es"] : [])],
    explicit: requested !== undefined,
    spanish,
    espeakData: inputs.espeak.data.filter(file => spanish || !spanishData.includes(file)),
    spanishData,
  };
}

export function verifyVoiceProductBundle(inputs, product, record, manifest) {
  const recorded = record.productLanguages ?? (product.explicit ? null : voiceProductInputs(inputs).languages);
  if (JSON.stringify(recorded) !== JSON.stringify(product.languages)) throw new Error("Voice build language selection differs from the consuming product");
  if (manifest.format !== "eliza-paradee-voice-v2" &&
      !(manifest.format === "eliza-paradee-voice-v1" && !product.explicit && !product.spanish)) {
    throw new Error("The selected product needs a v2 voice manifest");
  }
  const voices = manifest.voices ?? {};
  if (!voices || typeof voices !== "object" || Array.isArray(voices) ||
      JSON.stringify(Object.keys(voices).sort()) !== JSON.stringify(product.spanish ? ["es"] : []) ||
      (product.spanish && voices.es !== inputs.spanish.path)) {
    throw new Error("Voice manifest languages differ from the consuming product");
  }
  const prefix = "assets/paradee-voice/v1/";
  const files = record.files;
  if (!Array.isArray(files) || !Array.isArray(manifest.files)) throw new Error("Voice build file inventory is missing");
  if (manifest.model !== inputs.paradee.path || manifest.lexicon !== inputs.lexicon.path || manifest.espeakDir !== path.posix.dirname(inputs.paradee.path)) throw new Error("Voice manifest model identity differs from pinned inputs");
  const recordedAssets = files.filter(row => typeof row.path === "string" && row.path.startsWith(prefix) && row.path !== prefix + "manifest.json");
  if (new Set(manifest.files.map(row => row.path)).size !== manifest.files.length || manifest.files.length !== recordedAssets.length ||
      manifest.files.some(row => !recordedAssets.some(asset => asset.path === prefix + row.path && asset.bytes === row.bytes && asset.sha256 === row.sha256))) {
    throw new Error("Voice manifest inventory differs from its build record");
  }
  const models = [inputs.paradee, inputs.lexicon, inputs.asr, inputs.vad, ...(product.spanish ? [inputs.spanish] : [])];
  for (const pin of models) {
    const rows = files.filter(row => row.path === prefix + pin.path);
    if (rows.length !== 1 || rows[0].bytes !== pin.bytes || rows[0].sha256 !== pin.sha256) throw new Error(`Voice input differs from pinned bytes: ${pin.path}`);
  }
  const tts = new Set([inputs.paradee.path, ...(product.spanish ? [inputs.spanish.path] : [])]);
  for (const row of files) {
    if (typeof row.path !== "string") throw new Error("Invalid voice build path");
    const relative = row.path.startsWith(prefix) ? row.path.slice(prefix.length) : "";
    if (relative.startsWith("tts/paradee/") && /\.gguf$/i.test(relative) && !tts.has(relative)) throw new Error("Undeclared speech model in product bundle");
    if (!product.spanish && (relative === inputs.spanish?.path || relative.startsWith("notices/delibes/") ||
        product.spanishData.some(file => relative === `tts/paradee/espeak-ng-data/${file}`))) throw new Error("Spanish assets are not selected by this product");
  }
  for (const relative of product.espeakData) {
    if (files.filter(row => row.path === `${prefix}${path.posix.dirname(inputs.paradee.path)}/espeak-ng-data/${relative}`).length !== 1) throw new Error(`Missing product eSpeak data: ${relative}`);
  }
  return product;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!["--inputs", "--languages", "--record", "--manifest"].includes(args[i]) || !args[i + 1] || options[args[i]]) throw new Error("Invalid voice product input arguments");
    options[args[i]] = args[i + 1];
  }
  if (!options["--inputs"]) throw new Error("--inputs is required");
  const read = file => JSON.parse(fs.readFileSync(file, "utf8"));
  const inputs = read(options["--inputs"]);
  const product = voiceProductInputs(inputs, options["--languages"]?.split(","));
  if (options["--record"] || options["--manifest"]) {
    if (!options["--record"] || !options["--manifest"]) throw new Error("--record and --manifest must be supplied together");
    verifyVoiceProductBundle(inputs, product, read(options["--record"]), read(options["--manifest"]));
  }
  process.stdout.write(JSON.stringify(product) + "\n");
  } catch (error) {
    process.stderr.write(`[voice-product] ${error.message}\n`);
    process.exitCode = 1;
  }
}
