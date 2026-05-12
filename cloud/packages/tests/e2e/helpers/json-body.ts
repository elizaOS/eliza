export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue;
}

export async function readJson<TBody>(response: Response): Promise<TBody> {
  return (await response.json()) as TBody;
}
