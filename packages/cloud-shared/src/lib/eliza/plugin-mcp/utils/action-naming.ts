function normalize(str: string): string {
  return str
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

export function toActionName(serverName: string, toolName: string): string {
  const server = normalize(serverName);
  const tool = normalize(toolName);

  if (!server) return tool || "_";
  if (!tool) return server + "_";
  if (tool.startsWith(server + "_")) return tool;

  return `${server}_${tool}`;
}

export function generateSimiles(serverName: string, toolName: string): string[] {
  const tool = normalize(toolName);
  const fullName = toActionName(serverName, toolName);

  const similes = [
    tool,
    `${serverName}/${toolName}`,
    `${serverName.toLowerCase()}/${toolName.toLowerCase()}`,
    `MCP_${fullName}`,
  ];

  const parts = toolName.split("_");
  if (parts.length === 2) {
    const reversed = `${parts[1]}_${parts[0]}`.toUpperCase();
    if (reversed !== tool) similes.push(reversed);
  }

  return [...new Set(similes)].filter((s) => s !== fullName);
}

export function parseActionName(
  actionName: string,
): { serverName: string; toolName: string } | null {
  const normalized = normalize(actionName);
  const idx = normalized.indexOf("_");
  if (idx === -1) return null;

  return {
    serverName: normalized.substring(0, idx).toLowerCase(),
    toolName: normalized.substring(idx + 1).toLowerCase(),
  };
}

export function actionNamesCollide(name1: string, name2: string): boolean {
  return normalize(name1) === normalize(name2);
}

export function makeUniqueActionName(
  serverName: string,
  toolName: string,
  existing: Set<string>,
): string {
  const name = toActionName(serverName, toolName);
  if (!existing.has(name)) return name;

  let suffix = 2;
  while (existing.has(`${name}_${suffix}`)) suffix++;
  return `${name}_${suffix}`;
}
