const ALLOWED_MEDIA_PROTOCOLS = new Set(["http:", "https:"]);

function mediaLinkError(kind: string): Error {
  return new Error(`${kind} message requires a valid http(s) media link`);
}

export function assertValidWhatsAppMediaLink(link: unknown, kind: string): string {
  if (typeof link !== "string" || !link.trim()) {
    throw mediaLinkError(kind);
  }

  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    throw mediaLinkError(kind);
  }

  if (!ALLOWED_MEDIA_PROTOCOLS.has(url.protocol) || url.username || url.password || !url.hostname) {
    throw mediaLinkError(kind);
  }

  return url.toString();
}
