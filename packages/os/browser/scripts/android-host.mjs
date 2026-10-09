/** Build-time identity only; never populated from model or website input. */
export function androidNativeHost(certificate, application = "ai.elizaos.app") {
  if (
    typeof application !== "string" ||
    application.length > 80 ||
    !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(application)
  )
    throw new Error(
      "Android native host must be a valid application ID of at most 80 characters",
    );
  if (typeof certificate !== "string" || !/^[a-fA-F0-9]{64}$/.test(certificate))
    throw new Error("Android app signing certificate SHA-256 is required");
  return { application, androidCertificates: [certificate.toUpperCase()] };
}
