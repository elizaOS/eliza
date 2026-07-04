/**
 * Browser-bundle shim aliased in place of Handlebars, exposing just `compile`
 * for the small templating dependencies use. It resolves dotted `{{path}}` /
 * unescaped `{{{path}}}` interpolations against the render context, treating
 * missing/nullish values as empty strings. Block helpers, partials, and
 * comments are intentionally unsupported (tags starting with #/`/`>`/`!` are
 * skipped), keeping the real Handlebars engine out of the renderer.
 */
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
