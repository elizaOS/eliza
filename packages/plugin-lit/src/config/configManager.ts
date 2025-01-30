import fs from "node:fs";
import path from "node:path";

export interface LitConfig {
  pkp: {
    tokenId: string;
    publicKey: string;
    ethAddress: string;
    solanaAddress?: string;
  };
  network: string;
  timestamp: number;
  evmWalletPrivateKey: string;
  solanaWalletPrivateKey?: string;
  wrappedKeyId?: string;
  capacityCredit?: {
    tokenId: string;
  };
}

export class LitConfigManager {
  private configPath: string;

  constructor() {
    this.configPath = path.join(process.cwd(), "lit-config.json");
    console.log("LitConfigManager initialized with path:", this.configPath);
  }

  loadConfig(): LitConfig | null {
    try {
      if (fs.existsSync(this.configPath)) {
        const config = JSON.parse(fs.readFileSync(this.configPath, "utf8"));
        return config;
      }
    } catch (error) {
      console.error("Error loading config:", error);
    }
    return null;
  }

  saveConfig(config: LitConfig): void {
    try {
      fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2));
    } catch (error) {
      console.error("Error saving config:", error);
    }
  }

  async verifyConfig(_config: LitConfig): Promise<boolean> {
    // Add verification logic here
    // For example, check if the PKP is still valid
    // Return false if verification fails
    return true;
  }
}
