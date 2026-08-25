/**
 * Out-of-process probe for the control-pattern execution boundary.
 *
 * `validation.test.ts` spawns this file with a hard spawn deadline and reads
 * the JSON verdict it prints. Running the production paths here rather than in
 * the Vitest worker means a matcher regression that reintroduces catastrophic
 * backtracking kills a throwaway child process instead of hanging the test
 * runner, and the hang is reported as a failure rather than as a timeout with
 * no evidence.
 *
 * argv[2] is a JSON array of `{ name, pattern, input, expectValid }`.
 */

import { getBuiltinType } from "../builtins";
import type { FormControl } from "../types";
import { validateField } from "../validation";

interface ProbeCase {
  name: string;
  pattern: string;
  input: string;
  expectValid: boolean;
}

function control(pattern: string): FormControl {
  return { key: "code", label: "Code", type: "text", pattern };
}

const cases = JSON.parse(process.argv[2] ?? "[]") as ProbeCase[];
const builtinText = getBuiltinType("text");
if (!builtinText?.validate) {
  throw new Error("built-in text control type is not registered");
}

const results = cases.map((probe) => {
  const fieldStart = performance.now();
  const fieldResult = validateField(probe.input, control(probe.pattern));
  const fieldMs = performance.now() - fieldStart;

  const builtinStart = performance.now();
  const builtinResult = builtinText.validate?.(
    probe.input,
    control(probe.pattern),
  );
  const builtinMs = performance.now() - builtinStart;

  return {
    name: probe.name,
    expectValid: probe.expectValid,
    validateFieldValid: fieldResult.valid,
    builtinValid: builtinResult?.valid ?? null,
    validateFieldMs: Math.round(fieldMs),
    builtinMs: Math.round(builtinMs),
  };
});

process.stdout.write(`${JSON.stringify({ results })}\n`);
