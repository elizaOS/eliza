/**
 * Signs an operator-reviewed release file with a local Ed25519 authority key.
 * The exclusive mode-0600 output contains only the public release envelope;
 * neither the private key nor its parsing diagnostics are printed.
 */
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { signConfidentialRelease } from "../src/services/confidential-release.ts";

try {
  const { values } = parseArgs({
    options: {
      input: { type: "string" },
      key: { type: "string" },
      output: { type: "string" },
    },
    strict: true,
  });
  if (!values.input || !values.key || !values.output) {
    throw new Error("Missing paths");
  }
  const input: unknown = JSON.parse(await readFile(values.input, "utf8"));
  const envelope = signConfidentialRelease(
    input,
    await readFile(values.key, "utf8"),
  );
  await writeFile(values.output, `${JSON.stringify(envelope)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  process.stdout.write(
    "Signed release envelope written. No VM was provisioned.\n",
  );
} catch {
  // error-policy:J1 CLI errors omit secret-bearing key/parser diagnostics.
  process.stderr.write(
    "Release signing failed. Check --input, Ed25519 --key, validity and a new --output path.\n",
  );
  process.exitCode = 1;
}
