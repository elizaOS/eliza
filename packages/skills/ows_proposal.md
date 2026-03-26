# OWS Wallet Plugin Proposal

Proposes adding OWS (Open Wallet Standard) as a wallet backend for ElizaOS agents.

Currently, agent plugins expect private keys via environment variables
(EVM_PRIVATE_KEY, SOLANA_PRIVATE_KEY). OWS would encrypt these keys
at rest in a local vault, decrypted only during signing.

See https://openwallet.sh
