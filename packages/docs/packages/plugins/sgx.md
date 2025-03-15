# SGX Plugin for Eliza

The SGX Plugin for Eliza enhances the platform by providing Intel SGX attestation capabilities.

Intel SGX is part of the Intel confidential computing technology portfolio that allows businesses to take advantage of the cloud while staying in control of their data. Intel SGX protects data actively being used in the processor and memory by creating a trusted execution environment (TEE) called an enclave.

### Trusted Execution Environment (TEE)
A Trusted Execution Environment (TEE) is a secure area within a main processor that ensures sensitive data is stored, processed, and protected in an isolated environment. TEEs provide a higher level of security by allowing applications to run in a protected space, safeguarding them from unauthorized access and potential threats.

### Software Guard Extensions (SGX)
Software Guard Extensions is a set of instructions on Intel processors for creating Trusted Execution Environments (TEE). SGX enables the creation of enclaves, which are protected areas of execution that ensure the confidentiality and integrity of the code and data within them. This allows applications to run securely, even in untrusted environments, by protecting sensitive information from being exposed to the host operating system or other applications.

### Attestation
The attestation of TEE is a security mechanism that enables a TEE to provide cryptographic proof of its integrity and authenticity to external parties. By generating a unique attestation report that includes information about the software and its execution state, a TEE can assure remote verifiers that the code running within it has not been altered and is operating as intended. This process is essential for establishing trust in secure applications, allowing them to interact confidently with other systems and services in potentially untrusted environments.

### Gramine
The attestation capabilities are based on [Gramine Library OS](https://github.com/gramineproject/gramine). Gramine is a Library OS for Unmodified Applications. Applications can benefit from confidentiality and integrity guarantees of Intel SGX, but developers need to be very skilled for effective partitioning and code modification for Intel SGX environment.
Gramine runs unmodified applications inside Intel SGX. It supports dynamically loaded libraries, runtime linking, multi-process abstractions, and file authentication. For additional security, Gramine performs cryptographic and semantic checks at untrusted host interface. Developers provide a manifest file to configure the application environment and isolation policies, Gramine automatically does the rest.

## Components

### Providers
- **sgxAttestationProvider**: This provider is responsible for generating SGX remote attestations within Gramine SGX environments.

## Usage

First, you need to prepare the SGX environment and install the Gramine dependencies.
You can install Gramine packages in your SGX machine or use the docker image. Follow the [Gramine installation options](https://gramine.readthedocs.io/en/latest/installation.html) for more details.

Then, start eliza in SGX:

```bash
pnpm i
pnpm build

# Start default character
SGX=1 make start
# Start specific character
SGX=1 make start -- --character "character/trump.character.json"
```

After starting Eliza, the provider `sgxAttestationProvider` will be registered into Eliza through plugin-sgx. The environment variable `SGX` is required to be set to `1` to enable plugin-sgx. And the `SGX` is always set to `1` in the SGX environment through the `eliza.manifest.template` file.

When Eliza starts, the `sgxAttestationProvider` will generate SGX attestation in each request. And you can use the `SgxAttestationProvider` to generate SGX remote attestations for your own plugins / clients.

### Example

```typescript
const sgxAttestationProvider = new SgxAttestationProvider();
const sgxAttestation = await sgxAttestationProvider.generateAttestation(userReport);
```

## Quick Start

First, you need to prepare a SGX enabled machine.

Then, you can use the following command to start a Gramine Docker container:

```bash
sudo docker run -it --name eliza_sgx \
    --mount type=bind,source={your_eliza_path},target=/root/eliza \
    --device /dev/sgx/enclave \
    --device /dev/sgx/provision \
    gramineproject/gramine:stable-jammy
```

After entering the docker, you can use the following command to prepare the Eliza environment:

```bash
# Generate the private key for signing the SGX enclave
gramine-sgx-gen-private-key

cd /root/eliza/

# Install nodejs and pnpm
# Node.js will be installed at `/usr/bin/node`.
# Gramine will utilize this path as the default Node.js location to run Eliza.
# If you prefer to use nvm for installing Node.js, please ensure to specify the Node.js path in the Makefile, as the installation path for nvm is not `/usr/bin/node`.
apt update
apt install -y build-essential
apt install -y curl
curl -fsSL https://deb.nodesource.com/setup_23.x | bash -
apt install -y nodejs=23.3.0-1nodesource1
npm install -g pnpm

# Build Eliza
pnpm i
pnpm build

# Copy the .env.example file to .env
cp .env.example .env
# Edit the .env file

# Start Eliza in SGX
SGX=1 make start -- --character "character/c3po.character.json"
```
