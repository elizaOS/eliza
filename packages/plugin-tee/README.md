# TEE Log Plugin for Eliza

The TEE Log Plugin for Eliza is designed to enhance the logging capabilities of the Eliza by providing a structured way to generate, store and verify TEE (Trusted Execution Environment) logs for agents. This plugin ensures that all sensitive interactions are securely logged, providing a transparent and tamper-resistant record of all sensitive activities.

## Background

As Eliza is a fully autonomous AI agent capable of running within a TEE, we need to demonstrate to the outside world that we are indeed operating within a TEE. This allows external parties to verify that our actions are protected by the TEE and that they are autonomously executed by Eliza, without any third-party interference. Therefore, it is necessary to leverage TEE's remote attestation and establish a TEE logging mechanism to prove that these operations are entirely and autonomously performed by Eliza within the TEE.

## Requirements

Since the TEE Logging is based on the TEE, it is necessary to have a TEE enabled environment. Currently, we support Intel SGX (Gramine) and Intel TDX (dstack).
- using Intel SGX (Gramine), you need to enable the plugin-sgx in the Eliza runtime, which is enabled in SGX env automatically.
- using Intel TDX (dstack), you need to enable the plugin-tee in the Eliza runtime.

## TEE Logging Mechanism

## TEE Logging Mechanism

1. **Key Pair Generation and Attestation**:
   - During startup, each agent generates a key pair and creates a remote attestation for the public key. The private key is securely stored in the TEE's encrypted memory. The agent's relevant information, along with the public key and attestation, is recorded in a local database. A new key pair is generated each time the agent is updated or restarted to ensure key security.

2. **Log Recording**:
   - For each log entry, basic information is recorded, including `agentId`, `roomId`, `userId`, `type`, `content`, and `timestamp`. This information is concatenated and signed using the agent's corresponding private key to ensure verifiability. The verification process follows this trust chain:
     - Verify the attestation.
     - Trust the public key contained in the attestation.
     - Use the public key to verify the signature.
     - Trust the complete log record.

3. **Data Storage**:
   - All log data must be stored in the TEE's encrypted file system in production environments. Storing data in plaintext is prohibited to prevent tampering.

4. **Log Extraction for Verification**:
   - Third parties can extract TEE logs for verification purposes. Two types of information can be extracted:
     - **Agent Information**: This includes the agent's metadata, public key, and attestation, which can be used to verify the agent's public key.
     - **Log Information**: Required logs can be extracted, with the agent's attestation and public key used to verify the signature, ensuring that each record remains untampered.

5. **Integrity Protection**:
   - When users extract TEE logs via the REST API, the results are hashed, and an attestation is generated. After extraction, users can verify the attestation by comparing the hash value contained within it to the extracted results, thereby ensuring the integrity of the data.

## Services

- **[TeeLogService]**: This service is responsible for generating and storing TEE logs for agents.

### Class: TeeLogService

The `TeeLogService` class implements the `ITeeLogService` interface and extends the `Service` class. It manages the logging of sensitive interactions within a Trusted Execution Environment (TEE).

#### Methods

- **getInstance()**: `TeeLogService`
  - Returns the singleton instance of the `TeeLogService`.

- **static get serviceType()**: `ServiceType`
  - Returns the service type for TEE logging.

- **async initialize(runtime: IAgentRuntime): Promise<void>**
  - Initializes the TEE log service. It checks the runtime settings to configure the TEE type and enables logging if configured.

- **async log(agentId: string, roomId: string, userId: string, type: string, content: string): Promise<boolean>**
  - Logs an interaction with the specified parameters. Returns `false` if TEE logging is not enabled.

- **async getAllAgents(): Promise<TeeAgent[]>**
  - Retrieves all agents that have been logged. Returns an empty array if TEE logging is not enabled.

- **async getAgent(agentId: string): Promise<TeeAgent | undefined>**
  - Retrieves the details of a specific agent by their ID. Returns `undefined` if TEE logging is not enabled.

- **async getLogs(query: TeeLogQuery, page: number, pageSize: number): Promise<PageQuery<TeeLog[]>>**
  - Retrieves logs based on the provided query parameters. Returns an empty result if TEE logging is not enabled.

- **async generateAttestation(userReport: string): Promise<string>**
  - Generates an attestation based on the provided user report.

### Storage

The TEE logs are stored in a SQLite database, which is located at `./data/tee_log.sqlite`. The database is automatically created when the service is initialized.

Important: You need to use the encrypted file system to store the database file in production, otherwise the database will be compromised. Since TEE only protects memory-in-use, the disk is not protected by the TEE. However, Many TEE development tools support the encrypted file system, for example, you can refer to the [Gramine Encrypted files](https://gramine.readthedocs.io/en/latest/manifest-syntax.html#encrypted-files) documentation for more information.

### Usage

To use the `TeeLogService`, ensure that the TEE environment is properly configured and initialized.

Enable the TEE logging in the Eliza .env file:

```env
TEE_LOG_ENABLED=true
```

The logging isn't integrated for actions by default, you need to integrate the logging for the actions you want to log. For example, if you want to log the `Continue` action of plugin-bootstrap, you can do the following:

First, add plugin-tee-log to the dependencies of plugin-bootstrap:

```json
"@elizaos/plugin-tee-log": "workspace:*",
```

Then, add the following code to the `Continue` action:

```typescript
import {
    ServiceType,
    ITeeLogService,
} from "@elizaos/core";


// In the handler of the action
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        options: any,
        callback: HandlerCallback
    ) => {
        // Continue the action

        // Log the action
        const teeLogService = runtime
            .getService<ITeeLogService>(ServiceType.TEE_LOG)
            .getInstance();
        if (teeLogService.log(
                runtime.agentId,
                message.roomId,
                message.userId,
                "The type of the log, for example, Action:CONTINUE",
                "The content that you want to log"
            )
        ) {
            console.log("Logged TEE log successfully");
        }

        // Continue the action
    }
```

After configuring the logging for the action, you can run the Eliza and see the logs through the client-direct REST API. See more details in the [Client-Direct REST API](../client-direct/src/README.md) documentation.