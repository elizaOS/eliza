/** Reads a secret-bearing snapshot from stdin; prints only transfer counts. */
import { transferLoginState } from "./auth/store-transfer";
import { createPostgresClient } from "./db/client";

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (
    args.length > 1 ||
    (args.length === 1 && args[0] !== "--apply-source-quiesced")
  ) {
    throw new Error("Expected no arguments or --apply-source-quiesced");
  }
  const sql = createPostgresClient();
  try {
    const snapshot: unknown = JSON.parse(await Bun.stdin.text());
    const result = await transferLoginState(
      sql,
      snapshot,
      args.length ? "apply-quiesced" : "validate",
    );
    console.log(JSON.stringify(result));
  } catch {
    // error-policy:J2 CLI output must never contain database or token payloads.
    console.error(
      "Login state transfer failed; no partial import was committed.",
    );
    process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}
