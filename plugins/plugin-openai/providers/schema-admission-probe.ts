/** Isolates structured enum admission in an explicitly enabled diagnostic run.
 * The probe preserves the complete original request and records only structural
 * paths and HTTP status. Its response never enters the runtime or executes tools.
 */
import { logger } from "@elizaos/core";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
let probed = false;

function projectEnums(value: Json, path: string, paths: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((child, index) => projectEnums(child, `${path}[${index}]`, paths));
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (
    Array.isArray(value.enum) &&
    value.enum.some((item) => item !== null && typeof item === "object")
  ) {
    const constraint = `Allowed complete JSON values: ${JSON.stringify(value.enum)}.`;
    value.description =
      typeof value.description === "string" ? `${value.description}\n${constraint}` : constraint;
    delete value.enum;
    paths.push(path);
  }
  for (const [key, child] of Object.entries(value)) {
    if (key !== "description") projectEnums(child, `${path}.${key}`, paths);
  }
}

export async function probeSchemaAdmission(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
  response: Response
): Promise<void> {
  if (
    probed ||
    process.env.ELIZA_SCHEMA_ADMISSION_PROBE !== "1" ||
    response.status !== 400 ||
    typeof init?.body !== "string"
  )
    return;
  const body = JSON.parse(init.body) as { [key: string]: Json };
  if (!Array.isArray(body.tools)) return;
  const handler = body.tools.find(
    (tool) =>
      tool !== null &&
      !Array.isArray(tool) &&
      typeof tool === "object" &&
      tool.function !== null &&
      !Array.isArray(tool.function) &&
      typeof tool.function === "object" &&
      tool.function.name === "HANDLE_RESPONSE"
  );
  if (!handler || typeof handler !== "object" || Array.isArray(handler)) return;
  probed = true;
  const paths: string[] = [];
  projectEnums(handler, "HANDLE_RESPONSE", paths);
  logger.warn(
    { model: body.model, paths, controlStatus: response.status },
    "[SchemaAdmissionProbe] Structured enum probe starting"
  );
  if (paths.length === 0) return;
  const result = await globalThis.fetch(input, {
    ...init,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45_000),
  });
  logger.warn(
    { model: body.model, paths, probeStatus: result.status },
    "[SchemaAdmissionProbe] Structured enum probe finished"
  );
  await result.body?.cancel();
}
