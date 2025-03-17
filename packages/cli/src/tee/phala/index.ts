import * as crypto from 'node:crypto';
import fs from 'node:fs';
import { x25519 } from '@noble/curves/ed25519';
import prompts from 'prompts';
import { CLOUD_URL, PHALA_CLOUD_API_URL } from './constants';
import { getApiKey } from './credential';
import { hexToUint8Array, uint8ArrayToHex } from './lib';
import {
  createCvm,
  getCvmByAppId,
  getPubkeyFromCvm,
  listCvms,
  queryImages,
  queryTeepods,
  startCvm,
  upgradeCvm,
} from './phala-cloud';

/**
 * Interface for defining deployment options.
 * @typedef {Object} DeployOptions
 * @property {boolean} [debug] - Optional flag for enabling debug mode.
 * @property {string} [type] - Optional type of deployment.
 * @property {string} [mode] - Optional mode of deployment.
 * @property {string} name - Name of the deployment.
 * @property {number} [vcpu] - Optional number of virtual CPUs.
 * @property {number} [memory] - Optional amount of memory in MB.
 * @property {number} [diskSize] - Optional disk size in GB.
 * @property {string} [compose] - Optional compose file for deployment.
 * @property {string[]} [env] - Optional array of environment variables.
 * @property {string} [envFile] - Optional path to a file containing environment variables.
 * @property {Env[]} envs - Array of environment objects.
 */

interface DeployOptions {
  debug?: boolean;
  type?: string;
  mode?: string;
  name: string;
  vcpu?: number;
  memory?: number;
  diskSize?: number;
  compose?: string;
  env?: string[];
  envFile?: string;
  envs: Env[];
}

/**
 * Interface representing options for upgrading an application.
 * @typedef {Object} UpgradeOptions
 * @property {string} type - The type of upgrade.
 * @property {string} mode - The mode of upgrade.
 * @property {string} appId - The ID of the application.
 * @property {string} compose - The composition.
 * @property {string[]} [env] - Additional environment variables.
 * @property {string} [envFile] - The file containing environment variables.
 * @property {Env[]} envs - The list of environment variables.
 */
interface UpgradeOptions {
  type: string;
  mode: string;
  appId: string;
  compose: string;
  env?: string[];
  envFile?: string;
  envs: Env[];
}

/**
 * Interface representing environment variables with key-value pairs.
 * @interface
 * @property {string} key - The key for the environment variable.
 * @property {string} value - The value associated with the key.
 */
interface Env {
  key: string;
  value: string;
}

// Helper function to encrypt secrets
/**
 * Asynchronously encrypts the provided secrets using AES-GCM encryption with a shared key derived from the provided public key.
 *
 * @param {Env[]} secrets - The array of environment variables to be encrypted.
 * @param {string} pubkey - The public key used to derive the shared key for encryption.
 * @returns {Promise<string>} The encrypted data as a hexadecimal string.
 */
async function encryptSecrets(secrets: Env[], pubkey: string): Promise<string> {
  const envsJson = JSON.stringify({ env: secrets });

  // Generate private key and derive public key
  const privateKey = x25519.utils.randomPrivateKey();
  const publicKey = x25519.getPublicKey(privateKey);

  // Generate shared key
  const remotePubkey = hexToUint8Array(pubkey);
  const shared = x25519.getSharedSecret(privateKey, remotePubkey);

  // Import shared key for AES-GCM
  const importedShared = await crypto.subtle.importKey(
    'raw',
    shared,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt']
  );

  // Encrypt the data
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    importedShared,
    new TextEncoder().encode(envsJson)
  );

  // Combine all components
  const result = new Uint8Array(publicKey.length + iv.length + encrypted.byteLength);

  result.set(publicKey);
  result.set(iv, publicKey.length);
  result.set(new Uint8Array(encrypted), publicKey.length + iv.length);

  return uint8ArrayToHex(result);
}

// Function to handle deployment
/**
 * Deploy function to deploy a CVM with specified options
 *
 * @param {DeployOptions} options - The deployment options including name, compose file, environment variables, and debug flag
 * @returns {Promise<void>} - A Promise that resolves with no data upon successful deployment
 */
async function deploy(options: DeployOptions): Promise<void> {
  console.log('Deploying CVM ...');

  const vcpus = [
    { name: '1 vCPU', value: 1 },
    { name: '2 vCPUs', value: 2 },
    { name: '4 vCPUs', value: 4 },
    { name: '8 vCPUs', value: 8 },
    { name: '16 vCPUs', value: 16 },
    { name: '32 vCPUs', value: 32 },
    { name: '64 vCPUs', value: 64 },
  ];
  const memories = [
    { name: '1 GB', value: 1024 },
    { name: '2 GB', value: 2048 },
    { name: '4 GB', value: 4096 },
    { name: '8 GB', value: 8192 },
    { name: '16 GB', value: 16384 },
    { name: '32 GB', value: 32768 },
    { name: '64 GB', value: 65536 },
  ];
  const diskSizes = [
    { name: '10 GB', value: 10 },
    { name: '20 GB', value: 20 },
    { name: '30 GB', value: 30 },
    { name: '40 GB', value: 40 },
    { name: '50 GB', value: 50 },
    { name: '60 GB', value: 60 },
    { name: '70 GB', value: 70 },
    { name: '80 GB', value: 80 },
    { name: '90 GB', value: 90 },
    { name: '100 GB', value: 100 },
  ];
  const teepods = await queryTeepods();

  const result = await prompts([
    {
      type: 'select',
      name: 'teepods',
      message: 'Select a teepod',
      choices: teepods.map((teepod) => ({
        title: `${teepod.name} [${teepod.status}]`,
        value: teepod.id,
      })),
    },
    {
      type: 'select',
      name: 'vcpu',
      message: 'Select a vcpu',
      choices: vcpus.map((vcpu) => ({
        title: vcpu.name,
        value: vcpu.value,
      })),
    },
    {
      type: 'select',
      name: 'memory',
      message: 'Select a memory',
      choices: memories.map((memory) => ({
        title: memory.name,
        value: memory.value,
      })),
    },
    {
      type: 'select',
      name: 'diskSize',
      message: 'Select a disk size',
      choices: diskSizes.map((diskSize) => ({
        title: diskSize.name,
        value: diskSize.value,
      })),
    },
  ]);

  let composeString = '';
  if (options.compose) {
    composeString = fs.readFileSync(options.compose, 'utf8');
  }

  // Prepare vm_config for the request
  const vm_config = {
    teepod_id: result.teepods, // TODO: get from /api/teepods
    name: options.name,
    image: 'dstack-dev-0.3.4',
    vcpu: result.vcpu,
    memory: result.memory,
    disk_size: result.diskSize,
    compose_manifest: {
      docker_compose_file: composeString,
      docker_config: {
        url: '',
        username: '',
        password: '',
      },
      features: ['kms', 'tproxy-net'],
      kms_enabled: true,
      manifest_version: 2,
      name: options.name,
      public_logs: true,
      public_sysinfo: true,
      tproxy_enabled: true,
    },
    listed: false,
  };

  const pubkey = await getPubkeyFromCvm(vm_config);
  if (!pubkey) {
    console.error('Error: Failed to get pubkey from CVM.');
    process.exit(1);
  }
  const app_env_encrypt_pubkey = pubkey.app_env_encrypt_pubkey;
  const app_id_salt = pubkey.app_id_salt;

  const encrypted_env = await encryptSecrets(options.envs, pubkey.app_env_encrypt_pubkey);

  options.debug && console.log('Pubkey:', app_env_encrypt_pubkey);
  options.debug && console.log('Encrypted Env:', encrypted_env);
  options.debug && console.log('Env:', options.envs);

  // Make the POST request
  const response = await createCvm({
    ...vm_config,
    encrypted_env,
    app_env_encrypt_pubkey,
    app_id_salt,
  });
  if (!response) {
    console.error('Error during deployment');
    return;
  }

  const appId = response.app_id;
  console.log('Deployment successful');
  console.log('App Id:', appId);
  console.log('App URL:', `${CLOUD_URL}/dashboard/cvms/app_${appId}`);
  process.exit(0);
}

/**
 * Asynchronous function to query and display information about teepods.
 * Requires a valid API key. If no API key is found, an error message is displayed and the process exits.
 * @returns {void}
 */
async function teepods() {
  console.log('Querying teepods...');
  const apiKey = getApiKey();
  if (!apiKey) {
    console.error('Error: API key not found. Please set an API key first.');
    process.exit(1);
  }
  const teepods = await queryTeepods();
  console.log('Teepods:');
  for (const teepod of teepods) {
    console.log(teepod.id, teepod.name, teepod.status);
  }
  process.exit(0);
}

/**
 * Query images for a given teepod.
 *
 * @param {string} teepodId - The ID of the teepod to query images for.
 * @returns {Promise<void>} - The promise that resolves once images are queried and logged.
 */
async function images(teepodId: string) {
  console.log('Querying images for teepod:', teepodId);

  const images = await queryImages(teepodId);
  if (!images) {
    process.exit(1);
  }
  console.log('Images:');
  for (const image of images) {
    console.log(image.name);
  }
  process.exit(0);
}

/**
 * Upgrade the specified app with the given options.
 * @param {UpgradeOptions} options - The options for the upgrade process.
 * @returns {void}
 */
async function upgrade(options: UpgradeOptions) {
  console.log('Upgrading app:', options.appId);
  const cvm = await getCvmByAppId(options.appId);
  if (!cvm) {
    console.error('CVM not found');
    process.exit(1);
  }

  let composeString = '';
  if (options.compose) {
    composeString = fs.readFileSync(options.compose, 'utf8');
  }

  let encrypted_env = '';
  if (options.envs.length > 0) {
    encrypted_env = await encryptSecrets(options.envs, cvm.encrypted_env_pubkey);
    console.log('Encrypted Env:', encrypted_env);
  }

  const vm_config = {
    compose_manifest: {
      docker_compose_file: composeString,
      manifest_version: 1,
      runner: 'docker-compose',
      version: '1.0.0',
      features: ['kms', 'tproxy-net'],
      name: `app_${options.appId}`,
    },
    encrypted_env,
    allow_restart: true,
  };

  const response = await upgradeCvm(options.appId, vm_config);
  if (!response) {
    console.error('Error during upgrade');
    process.exit(1);
  }

  if (response.detail && response.detail !== 'Accepted') {
    console.error('Fail to upgrade CVM:', response.detail);
    process.exit(1);
  }

  // Make sure the CVM is running,
  // because of EXITED status once finished upgraded
  let count = 0;
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    if (count > 5) {
      console.error('CVM is not running after 30 seconds');
      process.exit(1);
    }
    const cvm = await getCvmByAppId(options.appId);
    if (cvm?.status.toLowerCase() === 'exited') {
      // start the cvm
      await startCvm(options.appId);
    } else {
      break;
    }
    count++;
  }

  console.log('Upgrade successful');
  console.log('App Id:', options.appId);
  console.log('App URL:', `${CLOUD_URL}/dashboard/cvms/app_${options.appId}`);
  process.exit(0);
}

export {
  deploy,
  type DeployOptions,
  teepods,
  images,
  upgrade,
  type UpgradeOptions,
  type Env,
  listCvms,
};
