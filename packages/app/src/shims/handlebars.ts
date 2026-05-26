type TemplateContext = Record<string, unknown>;
type TemplateDelegate = (context: TemplateContext) => string;

function resolvePath(context: TemplateContext, path: string): unknown {
  return path
    .split(".")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce<unknown>((value, part) => {
      if (!value || typeof value !== "object") return undefined;
      return (value as Record<string, unknown>)[part];
    }, context);
}

function render(template: string, context: TemplateContext): string {
  return template.replace(
    /\{\{\{?\s*([^{}#/>!][^{}]*?)\s*\}?\}\}/g,
    (_match, key: string) => {
      const value = resolvePath(context, key);
      return value === undefined || value === null ? "" : String(value);
    },
  );
}

const Handlebars = {
  compile(template: string): TemplateDelegate {
    return (context: TemplateContext) => render(template, context ?? {});
  },
};

export default Handlebars;
