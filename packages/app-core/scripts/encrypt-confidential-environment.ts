/** Encrypts launch secrets from a private input file without printing plaintext or parser diagnostics. */
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { encryptConfidentialEnvironment } from "../src/services/confidential-environment.ts";

try {
  const { values } = parseArgs({
    options: {
      input: { type: "string" },
      authority: { type: "string" },
      output: { type: "string" },
    },
    strict: true,
  });
  if (!values.input || !values.authority || !values.output)
    throw new Error("Missing paths");
  const result = await encryptConfidentialEnvironment(
    JSON.parse(await readFile(values.input, "utf8")),
    await readFile(values.authority, "utf8"),
  );
  await writeFile(values.output, `${JSON.stringify(result)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  process.stdout.write(
    "Encrypted launch environment written. No VM was provisioned.\n",
  );
} catch {
  // error-policy:J1 CLI output excludes launch secrets and remote diagnostics.
  process.stderr.write(
    "Environment encryption failed. Check trusted input, authority, KMS signer and a new output path.\n",
  );
  process.exitCode = 1;
}
