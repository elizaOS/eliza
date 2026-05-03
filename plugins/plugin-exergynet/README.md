# @elizaos/plugin-exergynet

ExergyNet LNES-03 ZK-Compute Membrane Integration.

## Configuration

This plugin requires the following environment variables or character secrets:

- `SOLANA_PRIVATE_KEY`: Your base58-encoded Solana private key.
- `EXERGYNET_AUTO_SPEND`: Must be set to `"true"` to allow the agent to autonomously sign and broadcast transactions paying the 0.002 SOL compute toll. Without this, the agent will safely halt execution to prevent unintended financial loss.
- `RPC_URL` (Optional): Custom Solana RPC URL. Defaults to Mainnet-Beta.
