import { join } from "node:path";
import type { Check, CheckResult } from "../types.js";
import { readUtf8Safe } from "../util/fs.js";

export const trainingConsentBasis: Check = {
  id: "PI1.1-training-consent-basis",
  title: "datasets.yaml requires consent_basis per training source",
  tsc: ["PI1.1", "P3.1"],
  severity: "high",
  async run(ctx): Promise<CheckResult> {
    const path = join(ctx.elizaRoot, "packages/training/datasets.yaml");
    const src = readUtf8Safe(path);
    if (!src) {
      return {
        status: "fail",
        evidence: `Missing ${path}`,
        files: [path],
      };
    }
    if (!/consent_basis/.test(src)) {
      return {
        status: "fail",
        evidence: `datasets.yaml does not reference consent_basis. SOC2 PI1.1 + privacy requires lawful-basis attribution for training data sources.`,
        files: [path],
      };
    }
    return {
      status: "pass",
      evidence: `datasets.yaml references consent_basis.`,
      files: [path],
    };
  },
};

export const modelArtifactSigning: Check = {
  id: "PI1.5-model-artifact-signing",
  title: "Model publish script references KMS signing",
  tsc: ["PI1.5", "CC6.8"],
  severity: "high",
  async run(ctx): Promise<CheckResult> {
    const candidates = [
      "packages/training/scripts/publish_eliza1_model.py",
      "packages/training/scripts/publish_model.py",
      "packages/training/scripts/publish-model.py",
    ];
    for (const rel of candidates) {
      const src = readUtf8Safe(join(ctx.elizaRoot, rel));
      if (!src) continue;
      if (/kms|sign|signature/i.test(src)) {
        return {
          status: "pass",
          evidence: `${rel} references signing.`,
          files: [join(ctx.elizaRoot, rel)],
        };
      }
      return {
        status: "fail",
        evidence: `${rel} present but contains no signing references.`,
        files: [join(ctx.elizaRoot, rel)],
      };
    }
    return {
      status: "fail",
      evidence: `Expected a model publish script at one of: ${candidates.join(", ")}.`,
    };
  },
};
