export declare const jvmTestsRequired: () => boolean;
export declare const resolveOrgJsonJar: () =>
  | { jar: string; reason: null }
  | { jar: null; reason: string };
