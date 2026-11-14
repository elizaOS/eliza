// What a component says about itself beyond its types, in `<Component>.meta.ts(x)` beside it, as
// `export const meta: ComponentMeta<Props>`. The story generator, tests, docs and the editor read the same
// object, so it names nothing from Storybook, React or Effect.

export interface ComponentMeta<Props = Record<string, unknown>> {
  /** Values every generated story starts from: what a required prop needs, or what makes the default look real. */
  args?: Partial<Props>;
  /** Named variations on `args`: each becomes a story of `args` with these on top. */
  examples?: Record<string, Partial<Props>>;
  /** Named complete renderings, used as they are, without `args`. */
  states?: Record<string, Props>;
  /** The least and greatest meaningful value of a numeric prop: each becomes a story. */
  bounds?: { [K in keyof Props]?: readonly [min: number, max: number] };
  /** An Effect Schema of the props, or of some of them: sampled with a fixed seed for more stories. */
  schema?: unknown;
  /** Wraps every story, for a component that needs a provider or a sized container; returns what to render. */
  decorator?: (story: () => any) => unknown;
  /** Interactions by story name, run after the story mounts; each receives the runner's story context. */
  play?: Record<string, (context: any) => unknown>;
}
