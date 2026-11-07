/** Complete typed commands supported by a mounted native browser history surface. */
export type NativeHistoryCommand = { subaction: "back" | "forward" | "reload" };
export function parseNativeHistoryCommand(
  value: unknown,
): NativeHistoryCommand {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Browser command is required");
  const command = value as Record<string, unknown>;
  if (
    Object.keys(command).some((key) => key !== "subaction") ||
    !["back", "forward", "reload"].includes(String(command.subaction))
  )
    throw Error(
      "This mounted browser supports back, forward and reload without server tab IDs",
    );
  return { subaction: command.subaction as NativeHistoryCommand["subaction"] };
}
