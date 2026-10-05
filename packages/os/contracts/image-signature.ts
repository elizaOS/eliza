/** Byte contract shared by release signing, verification and installer execution. */
export interface ImageSignatureFields {
  url: string;
  architecture: string;
  sequence: number;
  compressedSize: number;
  expandedSize: number;
  sha256Compressed: string;
  sha256Expanded: string;
}

export function artifactSignaturePayload(
  image: ImageSignatureFields,
): Uint8Array {
  return new TextEncoder().encode(
    [
      "elizaOS-artifact-v1",
      image.url,
      image.architecture,
      String(image.sequence),
      String(image.compressedSize),
      String(image.expandedSize),
      image.sha256Compressed,
      image.sha256Expanded,
      "",
    ].join("\n"),
  );
}
