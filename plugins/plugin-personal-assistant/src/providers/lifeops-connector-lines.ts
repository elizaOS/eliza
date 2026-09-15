/** Groups identical connector status messages while retaining every affected connector. */

export interface ConnectorLineStatus {
  label: string;
  state: string;
  message?: string;
}

export function formatConnectorDegradationLines(
  statuses: ReadonlyArray<ConnectorLineStatus>,
): string[] {
  const groups = new Map<string, string[]>();
  for (const { label, state, message } of statuses) {
    if (state === "ok") continue;
    const key = `${state}${message ? `: ${message}` : ""}`;
    const labels = groups.get(key);
    if (labels) labels.push(label);
    else groups.set(key, [label]);
  }
  return [...groups.entries()].map(([key, labels]) =>
    labels.length === 1
      ? `Connector ${labels[0]} ${key}`
      : `Connectors ${labels.join(", ")} ${key}`,
  );
}
