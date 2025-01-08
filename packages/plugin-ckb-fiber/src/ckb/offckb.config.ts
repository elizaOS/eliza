// this file is generated by offckb-cli

import systemScripts from "./offckb/system-scripts.json";
import myScripts from "./offckb/my-scripts.json";

export type Network = "devnet" | "testnet" | "mainnet";
export type AddressPrefix = 'ckb' | 'ckt';

export enum SystemScriptName {
  secp256k1_blake160_sighash_all = 'secp256k1_blake160_sighash_all',
  secp256k1_blake160_multisig_all = 'secp256k1_blake160_multisig_all',
  dao = 'dao',
  sudt = 'sudt',
  xudt = 'xudt',
  omnilock = 'omnilock',
  anyone_can_pay = 'anyone_can_pay',
  always_success = 'always_success',
  spore = 'spore',
  spore_cluster = 'spore_cluster',
  spore_cluster_agent = 'spore_cluster_agent',
  spore_cluster_proxy = 'spore_cluster_proxy',
  spore_extension_lua = 'spore_extension_lua',
}

export interface ScriptInfo {
  codeHash: `0x${string}`;
  hashType: 'type' | 'data';
  cellDeps: {
    cellDep: {
      outPoint: {
        txHash: `0x${string}`;
        index: number;
      };
      depType: 'code' | 'dep_group';
    };
  }[];
}

export interface SystemScript {
  name: string;
  file?: string;
  script: ScriptInfo;
}

export type SystemScriptsRecord = Record<SystemScriptName, SystemScript | undefined>;

export interface NetworkSystemScripts {
  devnet: SystemScriptsRecord;
  testnet: SystemScriptsRecord;
  mainnet: SystemScriptsRecord;
}

export type MyScriptsRecord = Record<string, ScriptInfo | undefined>;

export interface NetworkMyScripts {
  devnet: MyScriptsRecord;
  testnet: MyScriptsRecord;
  mainnet: MyScriptsRecord;
}

const networkSystemScripts: NetworkSystemScripts = systemScripts
const networkMyScripts: NetworkMyScripts = myScripts

export interface NetworkConfig {
  rpc_url: string;
  addressPrefix: AddressPrefix;
}

export interface OffCKBConfig {
  readonly version: string;
  readonly contractBinFolder: string;
  readonly contractInfoFolder: string;
  readonly networks: {
    devnet: NetworkConfig;
    testnet: NetworkConfig;
    mainnet: NetworkConfig;
  };
  readonly currentNetwork: Network;
  readonly addressPrefix: AddressPrefix;
  readonly rpcUrl: string;
  readonly systemScripts: SystemScriptsRecord;
  readonly myScripts: MyScriptsRecord;
}

export function readEnvNetwork(): Network {
  // you may need to update the env method
  // according to your frontend framework
  const network = process.env.NETWORK;
  const defaultNetwork = 'testnet';
  if (!network) return defaultNetwork;

  if (!['devnet', 'testnet', 'mainnet'].includes(network)) {
    return defaultNetwork;
  }

  return network as Network;
}

const offCKBConfig: OffCKBConfig = {
  version: '0.3.0-rc1',
  contractBinFolder: '../build/release',
  // this folder record the script deployment information
  // If you change this folder, you need to update the following get systemScripts and get myScripts method
  contractInfoFolder: './offckb',
  networks: {
    devnet: {
      rpc_url: 'http://127.0.0.1:9000', // 9000 is the default proxy port for CKB node rpc, if you don't need proxy, you can change it to 'https://localhost:8114'
      addressPrefix: 'ckt',
    },
    testnet: {
      rpc_url: 'https://testnet.ckb.dev/rpc',
      addressPrefix: 'ckt',
    },
    mainnet: {
      rpc_url: 'https://mainnet.ckb.dev/rpc',
      addressPrefix: 'ckb',
    },
  },

  get currentNetwork() {
    const network = readEnvNetwork();
    return network;
  },

  get addressPrefix() {
    const network = readEnvNetwork();
    return this.networks[network].addressPrefix;
  },

  get rpcUrl() {
    const network = readEnvNetwork();
    return this.networks[network].rpc_url;
  },

  get systemScripts() {
    const network = readEnvNetwork();
    // const networkSystemScripts: NetworkSystemScripts = require('./offckb/system-scripts.json');
    return networkSystemScripts[network];
  },

  get myScripts() {
    const network = readEnvNetwork();
    // const networkMyScripts: NetworkMyScripts = require('./offckb/my-scripts.json');
    return networkMyScripts[network];
  },
};

export default offCKBConfig;
