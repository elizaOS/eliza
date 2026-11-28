// spec/os/android/networkPolicy.md, "Story: Download a large file only on a link I do not pay for"

export interface MeteredHint {
  metered: boolean | null;
  source: "android-os";
}

export interface PathHints {
  isExpensive: boolean | null;
  isConstrained: boolean | null;
  source: "nw-path-monitor";
}

export interface NetworkPolicyPlugin {
  getMeteredHint(): Promise<MeteredHint>;
  getPathHints?(): Promise<PathHints>;
}
