/** Provides a deterministic host-external view bundle for Storybook. */
export default async function createStorybookView(hostImport) {
  const React = await hostImport("react");

  function StorybookView(props) {
    return React.createElement(
      "section",
      { className: "flex min-h-64 flex-col gap-3 p-6 text-txt" },
      props.contentHeader ?? null,
      props.leftNav ?? null,
      React.createElement(
        "h2",
        { className: "text-lg font-semibold text-txt-strong" },
        props.title ?? "Dynamic view loaded",
      ),
      React.createElement(
        "p",
        { className: "text-sm text-muted-strong" },
        "The Storybook bundle loaded through the production host-import contract.",
      ),
    );
  }

  return { default: StorybookView, VectorBrowserView: StorybookView };
}
