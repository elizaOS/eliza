/**
 * Normalize command payloads before they reach the embedded terminal runner.
 *
 * Some model/tool transports wrap multiline shell scripts in XML CDATA. If that
 * wrapper leaks through to the shell, the terminal tries to execute
 * `<![CDATA[...` as a command. Convert that transport wrapper into a normal
 * shell invocation while keeping the API's single-line command contract.
 */
export function normalizeTerminalCommand(rawCommand: string): string {
  const command = rawCommand.trim();
  const cdataMatch = command.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  if (!cdataMatch) return command;

  const script = cdataMatch[1].trim();
  if (!script) return "";

  const encoded = Buffer.from(script, "utf8").toString("base64");
  return `bash -lc "$(printf %s ${encoded} | base64 -d)"`;
}
