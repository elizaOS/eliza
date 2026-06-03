import { join } from "node:path";
import type { Check, CheckResult } from "../types.js";
import { dirExists, readUtf8Safe } from "../util/fs.js";
import { walk } from "../util/fs.js";

export const pluginSignatureVerify: Check = {
  id: "CC6.8-plugin-signature-verify",
  title: "plugin-remote-manifest invokes a signature-verify primitive",
  tsc: ["CC6.8", "CC8.1"],
  severity: "high",
  async run(ctx): Promise<CheckResult> {
    const root = join(ctx.elizaRoot, "packages/plugin-remote-manifest");
    if (!dirExists(root)) {
      return {
        status: "fail",
        evidence: `packages/plugin-remote-manifest not present.`,
        files: [root],
      };
    }
    const files = await walk(root, { match: /\.(ts|js|mts)$/, maxDepth: 6 });
    const matches: string[] = [];
    for (const f of files) {
      const src = readUtf8Safe(f);
      if (!src) continue;
      // Real signature-verify call — not merely a `signature` type field.
      if (
        /(verifySignature|verifyManifestSignature|kms\.verify|crypto\.verify|nodeVerify|sodium_crypto_sign_verify)/.test(
          src,
        )
      ) {
        matches.push(f);
      }
    }
    return matches.length > 0
      ? {
          status: "pass",
          evidence: `Signature verification primitive invoked in ${matches.length} file(s).`,
          files: matches.slice(0, 5),
        }
      : {
          status: "fail",
          evidence: `plugin-remote-manifest contains no call to a signature verification primitive. SOC2 CC6.8 requires runtime integrity verification of installed code.`,
          files: [root],
        };
  },
};

export const subagentEnvAllowlist: Check = {
  id: "CC6.8-subagent-env-allowlist",
  title: "Sub-agent service applies a SAFE_ENV_KEYS allowlist",
  tsc: ["CC6.8", "CC6.3"],
  severity: "high",
  async run(ctx): Promise<CheckResult> {
    const path = join(
      ctx.elizaRoot,
      "packages/plugin-sub-agent-claude-code/src/sub-agent-service.ts",
    );
    const src = readUtf8Safe(path);
    if (!src) {
      return {
        status: "fail",
        evidence: `Missing ${path}`,
        files: [path],
      };
    }
    return /SAFE_ENV_KEYS/.test(src)
      ? {
          status: "pass",
          evidence: `SAFE_ENV_KEYS referenced in sub-agent service.`,
          files: [path],
        }
      : {
          status: "fail",
          evidence: `Sub-agent service does not enforce a SAFE_ENV_KEYS allowlist. SOC2 CC6.8 requires restricting environment exposure to spawned third-party code.`,
          files: [path],
        };
  },
};

export const firmwareSigningScript: Check = {
  id: "CC6.8-firmware-signing-script",
  title: "Firmware signing script present",
  tsc: ["CC6.8"],
  severity: "medium",
  async run(ctx): Promise<CheckResult> {
    const path = join(
      ctx.elizaRoot,
      "packages/chip/fw/signing/sign-firmware.sh",
    );
    return readUtf8Safe(path)
      ? {
          status: "pass",
          evidence: `Firmware signing script present.`,
          files: [path],
        }
      : {
          status: "fail",
          evidence: `Expected firmware signing script at ${path}.`,
          files: [path],
        };
  },
};
