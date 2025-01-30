export const gelatoContractInvocationTemplate = `
Extract the following details for interacting with a smart contract using Gelato Relay:
- **contractAddress** (string): The address of the contract to interact with.
- **functionName** (string): The function name to call on the contract.
- **abi** (array): Human-readable ABI of the contract.
- **args** (array, optional): Arguments for the contract function.
- **chain** (string): The chain identifier (e.g., sepolia, mainnet, arbitrumSepolia and all viem supported chains).

Provide the details in this JSON format:
{
    "contractAddress": "<contract_address>",
    "functionName": "<function_name>",
    "abi": ["<human_readable_abi>"],
    "args": [<arguments_array>],
    "chain": "<chain_identifier>"
}
`;
