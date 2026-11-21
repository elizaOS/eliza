/**
 * How a union of device operations is written for a model.
 *
 * The registered union has one closed branch per operation form, so a form can
 * be filtered for a turn and declared as a single-operation tool on its own.
 * A model reads the union as text on every planner call, and there forms that
 * take the same arguments repeat each other. Merging those branches shortens
 * the text and leaves the set of accepted operations exactly as it was: each
 * step below replaces two branches with one branch that accepts what either
 * of them accepted and nothing else. That matters beyond the text, because a
 * turn validates a model's arguments against the union it sent.
 */
import type { ActionParameterSchema } from "@elizaos/core";

/** JSON with object keys in a fixed order, so equal schemas compare equal. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
const nameSet = (names: readonly string[] = []) =>
  JSON.stringify([...names].sort());

/**
 * What decides whether a branch can merge with another. A tool is rendered
 * several times a turn and every pair of its branches is compared, so this is
 * worked out once for each branch.
 */
type Shape = {
  /**
   * Everything the branch states besides its fields. Absent when it takes
   * undeclared fields: its fields alone then do not say what it accepts.
   */
  frame?: string;
  /** The frame with the names of the fields and of the required ones. */
  outline: string;
  required: string;
  /** Each field's schema, as text. */
  fields: Record<string, string>;
  count: number;
};
function shapeOf(branch: ActionParameterSchema): Shape {
  const { properties = {}, required, ...rest } = branch;
  const frame = canonical(rest);
  return {
    ...(branch.type === "object" && branch.additionalProperties === false
      ? { frame }
      : {}),
    outline: `${frame}${nameSet(Object.keys(properties))}${nameSet(required)}`,
    required: nameSet(required),
    fields: Object.fromEntries(
      Object.entries(properties).map(([name, field]) => [
        name,
        canonical(field),
      ]),
    ),
    count: Object.keys(properties).length,
  };
}
type Shaped = { branch: ActionParameterSchema; shape: Shape };
const shaped = (branch: ActionParameterSchema): Shaped => ({
  branch,
  shape: shapeOf(branch),
});

function stringEnum(schema: ActionParameterSchema): string[] | undefined {
  const values = schema.type === "string" ? schema.enum : undefined;
  return values?.length && values.every((value) => typeof value === "string")
    ? (values as string[])
    : undefined;
}

/**
 * Two closed branches that differ in the values of one string-enum field
 * accept, together, what one branch with both sets of values accepts.
 */
function mergedOnOneEnum(
  left: Shaped,
  right: Shaped,
): ActionParameterSchema | undefined {
  if (
    left.shape.frame === undefined ||
    left.shape.outline !== right.shape.outline
  )
    return;
  const differing = Object.keys(left.shape.fields).filter(
    (name) => left.shape.fields[name] !== right.shape.fields[name],
  );
  if (differing.length !== 1) return;
  const [name] = differing;
  const leftField = left.branch.properties?.[name] ?? {};
  const rightField = right.branch.properties?.[name] ?? {};
  const leftValues = stringEnum(leftField);
  const rightValues = stringEnum(rightField);
  if (!leftValues || !rightValues) return;
  // Everything else about the field, its description included, must agree.
  const { enum: _left, ...leftRest } = leftField;
  const { enum: _right, ...rightRest } = rightField;
  if (canonical(leftRest) !== canonical(rightRest)) return;
  return {
    ...left.branch,
    properties: {
      ...left.branch.properties,
      [name]: {
        ...leftField,
        enum: [
          ...leftValues,
          ...rightValues.filter((value) => !leftValues.includes(value)),
        ],
      },
    },
  };
}

/**
 * A closed branch and the same branch with one more required field accept,
 * together, what the longer branch accepts with that field optional.
 */
function mergedOnOneOptionalField(
  left: Shaped,
  right: Shaped,
): ActionParameterSchema | undefined {
  const [short, long] =
    left.shape.count <= right.shape.count ? [left, right] : [right, left];
  if (
    long.shape.count !== short.shape.count + 1 ||
    short.shape.frame === undefined ||
    short.shape.frame !== long.shape.frame
  )
    return;
  const added = Object.keys(long.shape.fields).filter(
    (name) => !Object.hasOwn(short.shape.fields, name),
  );
  if (
    added.length !== 1 ||
    Object.keys(short.shape.fields).some(
      (name) => short.shape.fields[name] !== long.shape.fields[name],
    ) ||
    long.shape.required !==
      nameSet([...(short.branch.required ?? []), added[0]])
  )
    return;
  const { required: _required, ...rest } = long.branch;
  return short.branch.required
    ? { ...long.branch, required: short.branch.required }
    : rest;
}

/** Whether every object in the schema requires all of its fields. */
function requiresEveryField(schema: ActionParameterSchema): boolean {
  return (
    Object.entries(schema.properties ?? {}).every(
      ([name, field]) =>
        schema.required?.includes(name) === true && requiresEveryField(field),
    ) &&
    (schema.items === undefined || requiresEveryField(schema.items)) &&
    [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])].every(requiresEveryField)
  );
}

/**
 * Merges branches that take the same arguments until no two do. Order is
 * kept: a merged branch stays where its first member was, and its values keep
 * the order of the branches they came from.
 *
 * A provider decodes a union as a strict grammar only while every object in
 * it requires all of its fields. A union that still qualifies is not given an
 * optional field, so it keeps its branch for each required set.
 */
export function mergeOperationBranches(
  branches: readonly ActionParameterSchema[],
): ActionParameterSchema[] {
  const everyFieldRequired = branches.every(requiresEveryField);
  const merged = branches.map(shaped);
  for (let changed = true; changed; ) {
    changed = false;
    search: for (let i = 0; i < merged.length; i++)
      for (let j = i + 1; j < merged.length; j++) {
        const union =
          mergedOnOneEnum(merged[i], merged[j]) ??
          (everyFieldRequired
            ? undefined
            : mergedOnOneOptionalField(merged[i], merged[j]));
        if (!union) continue;
        merged[i] = shaped(union);
        merged.splice(j, 1);
        changed = true;
        break search;
      }
  }
  return merged.map(({ branch }) => branch);
}
