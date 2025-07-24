export type DataDescription<T extends {}> = {
  [K in keyof T]: {
    type: "string" | "number" | "bigint" | "boolean" | "object" | "array";
    default?: string;
    description: string;
  };
};

export const formatKeys = <T extends {}>(desc: DataDescription<T>) => {
  return (Object.entries(desc) as [string, DataDescription<T>[keyof T]][])
    .map(
      ([key, value]) =>
        `- "${key}" - ${value.description}; or ${value.default ?? "null"} if not found`
    )
    .join("\n");
};

export const formatOutput = <T extends {}>(desc: DataDescription<T>) => {
  return `Respond using JSON format like this:
{
${(Object.entries(desc) as [string, DataDescription<T>[keyof T]][])
  .map(
    ([key, value]) =>
      `  "${key}": ${value.type} | null`
  )
  .join(",\n")}
}`;
};
