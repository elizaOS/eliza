/**
 * Validates one absolute Terraform resource-instance address before a protected
 * state operation passes it to the Terraform CLI as a single argument.
 */

import { pathToFileURL } from "node:url";

const IDENTIFIER = "[A-Za-z_][A-Za-z0-9_-]*";
const INSTANCE_KEY = "[A-Za-z0-9_.*:/|@+-]+";
const INSTANCE_INDEX = `(?:\\[[0-9]+\\]|\\["${INSTANCE_KEY}"\\])`;
const MODULE_PREFIX = `(?:module\\.${IDENTIFIER}(?:${INSTANCE_INDEX})?\\.)*`;
const RESOURCE = `(?:data\\.)?${IDENTIFIER}\\.${IDENTIFIER}(?:${INSTANCE_INDEX})?`;
const TERRAFORM_STATE_ADDRESS = new RegExp(`^${MODULE_PREFIX}${RESOURCE}$`);

export function isSafeTerraformStateAddress(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    TERRAFORM_STATE_ADDRESS.test(value)
  );
}

function main(argv) {
  if (argv.length !== 1 || !isSafeTerraformStateAddress(argv[0])) {
    console.error(
      "Terraform state address must be one absolute resource-instance address",
    );
    return 1;
  }
  console.log("Validated exact Terraform state address shape.");
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = main(process.argv.slice(2));
}
