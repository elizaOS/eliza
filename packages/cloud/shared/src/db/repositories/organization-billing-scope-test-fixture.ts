/** Keeps focused infrastructure fixtures compatible with shared billing columns; app constraints are exercised by the full app migration fixture. */
import { readFile } from "node:fs/promises";

export async function installOrganizationBillingScopeTestColumns(
  execute: (statement: string) => Promise<unknown>,
): Promise<void> {
  const columns = await readFile(
    new URL("../migrations/0399_subscription_app_scope_columns.sql", import.meta.url),
    "utf8",
  );
  for (const statement of columns.split("--> statement-breakpoint"))
    if (statement.trim()) await execute(statement);
  const commands = await readFile(
    new URL("../migrations/0404_app_billing_command_intents.sql", import.meta.url),
    "utf8",
  );
  for (const statement of commands.split("--> statement-breakpoint")) {
    if (statement.trim().startsWith('ALTER TABLE "billing_subscription_commands" ADD COLUMN'))
      await execute(statement.replace("ADD COLUMN", "ADD COLUMN IF NOT EXISTS"));
  }
}
