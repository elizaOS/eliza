export declare namespace Schema {
  interface Schema<Type> { Type: Type }
  const Int: Schema<number>;
  function Struct<Fields extends Record<string, Schema<unknown>>>(fields: Fields): Schema<{ [Name in keyof Fields]: Fields[Name]["Type"] }>;
}
