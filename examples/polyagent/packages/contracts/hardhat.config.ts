import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "hardhat-preprocessor";

const __dirname = dirname(fileURLToPath(import.meta.url));

function getRemappings(): Array<[string, string]> {
  const remappingsPath = join(__dirname, "remappings.txt");
  const content = readFileSync(remappingsPath, "utf8");
  return (
    content
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        const [from, to] = line.trim().split("=");
        return [from, to] as [string, string];
      })
      // Only apply remappings that point to local dependencies folder
      // Hardhat can resolve node_modules packages directly
      .filter(([, to]) => to.startsWith("dependencies/"))
  );
}

const config: HardhatUserConfig = {
  solidity: {
    compilers: [
      {
        version: "0.8.33",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
          viaIR: true,
          evmVersion: "cancun",
        },
      },
      {
        version: "0.8.27",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
          viaIR: true,
          evmVersion: "cancun",
        },
      },
    ],
  },
  paths: {
    sources: "./",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  preprocess: {
    eachLine: () => ({
      transform: (line: string) => {
        const remappings = getRemappings();
        for (const [from, to] of remappings) {
          if (line.includes(from)) {
            return line.replace(from, to);
          }
        }
        return line;
      },
    }),
  },
  networks: {
    hardhat: {
      chainId: 31337,
      loggingEnabled: false,
      accounts: {
        mnemonic: "test test test test test test test test test test test junk",
        count: 10,
        accountsBalance: "10000000000000000000000", // 10000 ETH
      },
    },
    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 31337,
    },
  },
};

export default config;
