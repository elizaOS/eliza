export declare function applyLaunchConnection(args: {
  apiBase: string;
  token?: string | null;
  kind?: "cloud" | "remote";
  allowPublicHttps?: boolean;
}): {
  apiBase: string;
  token: string | null;
};
export declare function applyLaunchConnectionFromUrl(): Promise<boolean>;
//# sourceMappingURL=browser-launch.d.ts.map
