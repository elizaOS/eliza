# TEE Log Plugin for Eliza

## Purpose

Enhances logging capabilities by providing a structured way to generate, store and verify TEE (Trusted Execution Environment) logs for agents, ensuring sensitive interactions are securely logged with tamper-resistant records.

## Requirements

- Intel SGX (Gramine): enable plugin-sgx in Eliza runtime (automatic in SGX environments)
- Intel TDX (dstack): enable plugin-tee in Eliza runtime

## Configuration

Enable TEE logging in .env file:

```env
TEE_LOG_ENABLED=true
```

## Integration

- Import the service: `import { ServiceType, ITeeLogService } from '@elizaos/core'`
- Add plugin-tee-log to dependencies of target plugin
- Get service instance: `const teeLogService = runtime.getService<ITeeLogService>(ServiceType.TEE_LOG).getInstance()`
- Log interactions: `teeLogService.log(runtime.agentId, message.roomId, message.userId, 'Action:TYPE', 'content')`

## Storage

Logs stored in SQLite database at `./data/tee_log.sqlite`. Production environments must use encrypted file systems for security.
