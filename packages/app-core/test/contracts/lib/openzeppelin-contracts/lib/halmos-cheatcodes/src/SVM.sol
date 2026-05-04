// SPDX-License-Identifier: AGPL-3.0
pragma solidity >=0.8.0 <0.9.0;

/// @notice Symbolic Virtual Machine
interface SVM {
    // Create a new symbolic uint value ranging over [0, 2**bitSize - 1] (inclusive)
    function createUint(uint256 bitSize, string memory name) external pure returns (uint256 value);

    // Create a new symbolic uint256 value
    function createUint256(string memory name) external pure returns (uint256 value);

    // Create a new symbolic signed int value
    function createInt(uint256 bitSize, string memory name) external pure returns (int256 value);

    // Create a new symbolic int256 value
    function createInt256(string memory name) external pure returns (int256 value);

    // Create a new symbolic byte array with the given byte size
    function createBytes(uint256 byteSize, string memory name) external pure returns (bytes memory value);

    // Create a new symbolic string backed by a symbolic array with the given byte size
    function createString(uint256 byteSize, string memory name) external pure returns (string memory value);

    // Create a new symbolic bytes32 value
    function createBytes32(string memory name) external pure returns (bytes32 value);

    // Create a new symbolic bytes4 value
    function createBytes4(string memory name) external pure returns (bytes4 value);

    // Create a new symbolic address value
    function createAddress(string memory name) external pure returns (address value);

    // Create a new symbolic boolean value
    function createBool(string memory name) external pure returns (bool value);

    // Create arbitrary symbolic calldata for the given contract or interface name.
    // An exception is thrown if the contract name exists in multiple files. An optional filename (with .sol extension) can be provided to avoid ambiguity.
    // By default, view and pure functions are excluded. An optional boolean flag can be set to include view and pure functions.
    function createCalldata(string memory contractOrInterfaceName) external pure returns (bytes memory data);
    function createCalldata(string memory contractOrInterfaceName, bool includeViewAndPureFunctions) external pure returns (bytes memory data);
    function createCalldata(string memory filename, string memory contractOrInterfaceName) external pure returns (bytes memory data);
    function createCalldata(string memory filename, string memory contractOrInterfaceName, bool includeViewAndPureFunctions) external pure returns (bytes memory data);

    // Assign symbolic values to uninitialized storage slots
    function enableSymbolicStorage(address) external;

    // Snapshot the current storage of the given account and return a snapshot ID
    function snapshotStorage(address) external returns (uint256 id);
}
