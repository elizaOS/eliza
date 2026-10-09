/**
 * Creates one stopped TDX VM from an approved signed request and prints its
 * receipt. Authorization is read from the operator environment, never arguments
 * or output. Failed creation is not retried; reconcile VMM inventory first.
 */
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { provisionConfidentialVm } from "../src/services/confidential-provision.ts";

try {
  const { values } = parseArgs({
    options: { input: { type: "string" }, authority: { type: "string" } },
    strict: true,
  });
  if (!values.input || !values.authority)
    throw new Error("Missing input or authority path");
  const input: unknown = JSON.parse(await readFile(values.input, "utf8"));
  const authority = await readFile(values.authority, "utf8");
  const authorization = process.env.DSTACK_VMM_AUTHORIZATION;
  const receipt = await provisionConfidentialVm(
    input,
    authority,
    authorization === undefined ? {} : { authorization },
  );
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
} catch {
  // error-policy:J1 Do not print encrypted environments, credentials or remote diagnostics.
  process.stderr.write(
    "Provisioning failed or is unconfirmed. Check the signed request and reconcile VMM inventory before retrying.\n",
  );
  process.exitCode = 1;
}
