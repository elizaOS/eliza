// spec/cloud/returnPages.md, "Story: Bring me back to the app when its link did not open"; spec/cloud/returnPages.md, "Story: Tell a payer the checkout ended"
const rendered = new Map<string, Promise<string | undefined>>();

export function renderedTemplate(file: string): Promise<string | undefined> {
  const known = rendered.get(file) ?? import("./render.tsx").then(({ renderPages }) => renderPages("").find((page) => page.fileName === file)?.source);
  rendered.set(file, known);
  return known;
}
