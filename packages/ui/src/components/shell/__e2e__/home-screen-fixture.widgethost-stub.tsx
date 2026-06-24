// Stub WidgetHost for the home-screen e2e. HomeScreen mounts the unified
// home-slot WidgetHost (#9143), whose ranking + per-widget rendering pulls in
// the widget registry, app/notification stores, and Node-only services. Those
// internals are covered by the widgets suites + the home-widget-priority
// ui-smoke spec; this fixture is about the Home/Springboard shell + the
// consolidation, so we render a marker instead. Mirrors HomeScreen.test.tsx.
import * as React from "react";

export function WidgetHost(props: {
  slot: string;
}): React.JSX.Element {
  return <div data-testid="home-widget-host" data-slot={props.slot} />;
}
