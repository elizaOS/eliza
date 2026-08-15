/**
 * Node MIME sniffing boundary backed by `file-type`. Keeping the dependency in
 * this leaf lets platform builds replace only byte detection while every host
 * shares the same MIME precedence and extension rules.
 */

type FileTypeResult = { ext: string; mime: string } | undefined;
type FileTypeFromBuffer = (
	buffer: ArrayBuffer | Uint8Array,
) => Promise<FileTypeResult>;
type FileTypeModule = { fileTypeFromBuffer?: FileTypeFromBuffer };

let fileTypeModule: FileTypeModule | undefined;

export async function sniffMime(
	buffer?: Buffer | Uint8Array,
): Promise<string | undefined> {
	if (!buffer) return undefined;
	fileTypeModule ??= await import("file-type");
	const type = await fileTypeModule.fileTypeFromBuffer?.(buffer);
	return type?.mime;
}
