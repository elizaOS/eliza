/** Types for the portable Opus installer's deterministic verification API. */
export const OPUS_PACKAGE_VERSION: "0.10.0";
export const OPUS_PREBUILD_NODE_TARGET: "18.4.0";
export const OPUS_LINUX_MUSL_PREBUILDS: Readonly<
  Record<"arm64" | "x64", Readonly<{ directory: string; sha256: string }>>
>;

export function smokeTestOpus(packageRoot: string): {
  packetBytes: number;
  decodedBytes: number;
};

export function smokeTestOpusBinary(
  binaryPath: string,
): ReturnType<typeof smokeTestOpus>;

export function verifyPortableOpusPackage(options: {
  packageRoot: string;
  platform?: string;
  arch?: string;
  smokeTest?: boolean;
}): {
  arch: string;
  binaryPath: string;
  sha256: string;
  proof: ReturnType<typeof smokeTestOpus> | null;
};
