# WETH9 Bytecode

The WETH9 bytecode used in `deploy_weth_template()` is the canonical WETH9
contract from Ethereum mainnet (deployed at `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2`).

- **Solidity version**: 0.4.18 (pre-Forge, legacy compiler)
- **Source**: https://etherscan.io/address/0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2#code
- **Verified working on Anvil**: 2026-02-07

This bytecode is NOT compiled from our Forge setup because WETH9 uses Solidity 0.4.18
which is incompatible with our 0.8.33 setup. The bytecode is embedded directly in the
template as a hex string.
