/** Lazily load byte detection only when a media caller supplies bytes. */
export async function sniffMime(
  buffer?: Buffer | Uint8Array,
): Promise<string | undefined> {
  if (!buffer) return undefined;
  const { fileTypeFromBuffer } = await import("file-type");
  return (await fileTypeFromBuffer(buffer))?.mime;
}
