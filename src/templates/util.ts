export interface EnumWithDescription {
  name: string;
  description: string;
}

export function enumWithDescription(enums: EnumWithDescription[] | readonly EnumWithDescription[]) {
  return enums.map((item) => {
    return `- "${item.name}" - ${item.description}`;
  }).join("\n");
}