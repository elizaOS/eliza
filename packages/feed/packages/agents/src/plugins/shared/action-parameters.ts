import type { ActionParameter, ActionParameterSchema } from "@elizaos/core";

type LegacyActionParameter = Omit<
  ActionParameterSchema,
  "description" | "required"
> & {
  description: string;
  required?: boolean;
  optional?: boolean;
};

export function defineActionParameters(
  parameters: Record<string, LegacyActionParameter>,
): ActionParameter[] {
  return Object.entries(parameters).map(([name, parameter]) => {
    const { description, optional, required, ...schema } = parameter;
    return {
      name,
      description,
      required: required ?? (optional === undefined ? undefined : !optional),
      schema,
    };
  });
}
