export interface PairingCodeCommandInfo {
  serverCommand: string;
  sshCommand: string | null;
  sshTarget: string | null;
  usesDefaultPort: boolean;
  isLoopback: boolean;
}
export declare function buildPairingCodeCommandInfo(
  remoteUrl?: string,
): PairingCodeCommandInfo;
//# sourceMappingURL=pairing-command.d.ts.map
