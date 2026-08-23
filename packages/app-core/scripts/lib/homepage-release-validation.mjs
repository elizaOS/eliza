/**
 * Validates the generated homepage's explicit unavailable-release sentinel.
 * The checker and its tests share this pure contract so contradictory payloads
 * cannot silently render active download controls.
 */

export function unavailableReleaseFinding(release) {
  if (
    release.publishedAtLabel !== "unavailable" ||
    release.prerelease !== false
  ) {
    return {
      message: "unavailable release must use canonical publication metadata",
      details: [],
    };
  }
  if (release.url !== "https://github.com/elizaos/eliza/releases") {
    return {
      message: "unavailable release must link to the canonical releases page",
      details: [],
    };
  }
  if (!Array.isArray(release.downloads)) {
    return {
      message: "unavailable release must contain an empty downloads array",
      details: [],
    };
  }
  if (release.downloads.length > 0) {
    return {
      message: "unavailable release must not contain downloadable artifacts",
      details: [
        `found ids: ${release.downloads.map((download) => download.id).join(", ")}`,
      ],
    };
  }
  if (release.checksum != null) {
    return {
      message: "unavailable release must not contain a checksum artifact",
      details: [],
    };
  }
  return null;
}
