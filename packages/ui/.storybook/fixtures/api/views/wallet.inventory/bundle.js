/** Keeps the dynamic import pending so Storybook can capture the loading state. */
await new Promise(() => {});

export default function unreachableViewFactory() {
  throw new Error("The pending Storybook bundle must not resolve.");
}
