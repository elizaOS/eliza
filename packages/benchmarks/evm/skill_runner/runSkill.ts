/**
 * EVM Skill Runner — executes TypeScript skill files via Bun.
 *
 * Usage:
 *   bun runSkill.ts <skillFile> <timeoutMs> <rpcUrl> <privateKey> <chainId>
 *
 * The skill file must export:
 *   export async function executeSkill(rpcUrl: string, privateKey: string, chainId: number): Promise<string>
 *
 * The function should return a JSON string:
 *   { "results": [...], "error": null }
 */

const args = process.argv.slice(2);
const skillFile = args[0];
const timeoutMs = parseInt(args[1] || "30000", 10);
const rpcUrl = args[2] || "http://127.0.0.1:8545";
const privateKey = args[3] || "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const chainId = parseInt(args[4] || "31337", 10);

if (!skillFile) {
  console.log(JSON.stringify({ results: [], error: "No skill file specified" }));
  process.exit(1);
}

async function main() {
  // Create a timeout with a clearable timer
  let timeoutHandle: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error(`Skill execution timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });

  try {
    // Dynamically import the skill file
    const skillModule = await import(skillFile);

    if (typeof skillModule.executeSkill !== "function") {
      clearTimeout(timeoutHandle!);
      console.log(JSON.stringify({
        results: [],
        error: `Skill file does not export executeSkill function. Exports: ${Object.keys(skillModule).join(", ")}`,
      }));
      process.exit(1);
    }

    // Execute with timeout
    const resultStr = await Promise.race([
      skillModule.executeSkill(rpcUrl, privateKey, chainId),
      timeoutPromise,
    ]);

    // Clear timeout immediately so Bun can exit
    clearTimeout(timeoutHandle!);

    // Validate output is JSON
    try {
      const parsed = JSON.parse(resultStr);
      // Output the valid JSON on the last line
      console.log(JSON.stringify(parsed));
    } catch {
      // If not valid JSON, wrap it
      console.log(JSON.stringify({
        results: [],
        error: `Skill returned invalid JSON: ${String(resultStr).slice(0, 500)}`,
      }));
      process.exit(1);
    }
  } catch (err: unknown) {
    clearTimeout(timeoutHandle!);
    const errorMessage = err instanceof Error ? err.message : String(err);
    const errorStack = err instanceof Error ? err.stack : undefined;
    console.log(JSON.stringify({
      results: [],
      error: errorMessage,
      stack: errorStack?.slice(0, 1000),
    }));
    process.exit(1);
  }
}

main();
