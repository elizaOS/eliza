/** Supplies the minimal page-frame contract used by Phone component tests. */

import React from "react";

export function PluginPageFrame({
  children,
  title,
}: React.PropsWithChildren<{ title: string }>): React.JSX.Element {
  return React.createElement(
    "main",
    { "aria-label": `${title} page` },
    React.createElement("h1", null, title),
    children,
  );
}
