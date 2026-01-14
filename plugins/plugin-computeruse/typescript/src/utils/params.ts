import type { ActionParameters } from "@elizaos/core";

export function getStringParam(
  params: ActionParameters | undefined,
  name: string
): string | undefined {
  const val = params?.[name];
  return typeof val === "string" ? val : undefined;
}

export function getNumberParam(
  params: ActionParameters | undefined,
  name: string
): number | undefined {
  const val = params?.[name];
  return typeof val === "number" ? val : undefined;
}

export function getBooleanParam(
  params: ActionParameters | undefined,
  name: string
): boolean | undefined {
  const val = params?.[name];
  return typeof val === "boolean" ? val : undefined;
}
