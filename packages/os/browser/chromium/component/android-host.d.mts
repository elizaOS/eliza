export interface AndroidNativeHost {
  readonly application: string;
  readonly androidCertificates: readonly string[];
}

/** @throws {Error} when the application ID or certificate is not valid */
export function androidNativeHost(certificate: string, application?: string): AndroidNativeHost;
