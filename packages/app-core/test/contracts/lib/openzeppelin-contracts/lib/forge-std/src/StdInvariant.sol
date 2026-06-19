// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.13 <0.9.0;

abstract contract StdInvariant {
    struct FuzzSelector {
        address addr;
        bytes4[] selectors;
    }

    struct FuzzArtifactSelector {
        string artifact;
        bytes4[] selectors;
    }

    struct FuzzInterface {
        address addr;
        string[] artifacts;
    }

    address[] private _excludedContracts;
    address[] private _excludedSenders;
    address[] private _targetedContracts;
    address[] private _targetedSenders;

    string[] private _excludedArtifacts;
    string[] private _targetedArtifacts;

    FuzzArtifactSelector[] private _targetedArtifactSelectors;

    FuzzSelector[] private _excludedSelectors;
    FuzzSelector[] private _targetedSelectors;

    FuzzInterface[] private _targetedInterfaces;

    // Functions for users:
    // These are intended to be called in tests.

    /// @dev Excludes a contract address from invariant target selection.
    function excludeContract(address newExcludedContract_) internal {
        _excludedContracts.push(newExcludedContract_);
    }

    /// @dev Excludes specific selectors on a contract from invariant fuzzing.
    function excludeSelector(FuzzSelector memory newExcludedSelector_) internal {
        _excludedSelectors.push(newExcludedSelector_);
    }

    /// @dev Excludes a sender from invariant fuzzing; exclusion takes precedence over targeted senders.
    function excludeSender(address newExcludedSender_) internal {
        _excludedSenders.push(newExcludedSender_);
    }

    /// @dev Excludes an artifact identifier from invariant target selection.
    function excludeArtifact(string memory newExcludedArtifact_) internal {
        _excludedArtifacts.push(newExcludedArtifact_);
    }

    /// @dev Targets an artifact identifier for invariant fuzzing.
    function targetArtifact(string memory newTargetedArtifact_) internal {
        _targetedArtifacts.push(newTargetedArtifact_);
    }

    /// @dev Targets specific selectors for an artifact identifier during invariant fuzzing.
    function targetArtifactSelector(FuzzArtifactSelector memory newTargetedArtifactSelector_) internal {
        _targetedArtifactSelectors.push(newTargetedArtifactSelector_);
    }

    /// @dev Targets a contract address for invariant fuzzing.
    function targetContract(address newTargetedContract_) internal {
        _targetedContracts.push(newTargetedContract_);
    }

    /// @dev Targets specific selectors on a contract for invariant fuzzing.
    function targetSelector(FuzzSelector memory newTargetedSelector_) internal {
        _targetedSelectors.push(newTargetedSelector_);
    }

    /// @dev Adds a sender to the invariant sender allowlist; when non-empty, fuzzing uses only targeted non-excluded senders.
    function targetSender(address newTargetedSender_) internal {
        _targetedSenders.push(newTargetedSender_);
    }

    /// @dev Targets an address plus artifact interfaces for invariant fuzzing.
    function targetInterface(FuzzInterface memory newTargetedInterface_) internal {
        _targetedInterfaces.push(newTargetedInterface_);
    }

    // Functions for forge:
    // These are called by forge to run invariant tests and don't need to be called in tests.

    /// @dev Returns artifact identifiers configured via `excludeArtifact`.
    function excludeArtifacts() public view returns (string[] memory excludedArtifacts_) {
        excludedArtifacts_ = _excludedArtifacts;
    }

    /// @dev Returns contract addresses configured via `excludeContract`.
    function excludeContracts() public view returns (address[] memory excludedContracts_) {
        excludedContracts_ = _excludedContracts;
    }

    /// @dev Returns selector exclusions configured via `excludeSelector`.
    function excludeSelectors() public view returns (FuzzSelector[] memory excludedSelectors_) {
        excludedSelectors_ = _excludedSelectors;
    }

    /// @dev Returns senders configured via `excludeSender`.
    function excludeSenders() public view returns (address[] memory excludedSenders_) {
        excludedSenders_ = _excludedSenders;
    }

    /// @dev Returns artifact identifiers configured via `targetArtifact`.
    function targetArtifacts() public view returns (string[] memory targetedArtifacts_) {
        targetedArtifacts_ = _targetedArtifacts;
    }

    /// @dev Returns artifact-selector targets configured via `targetArtifactSelector`.
    function targetArtifactSelectors() public view returns (FuzzArtifactSelector[] memory targetedArtifactSelectors_) {
        targetedArtifactSelectors_ = _targetedArtifactSelectors;
    }

    /// @dev Returns contract addresses configured via `targetContract`.
    function targetContracts() public view returns (address[] memory targetedContracts_) {
        targetedContracts_ = _targetedContracts;
    }

    /// @dev Returns selector targets configured via `targetSelector`.
    function targetSelectors() public view returns (FuzzSelector[] memory targetedSelectors_) {
        targetedSelectors_ = _targetedSelectors;
    }

    /// @dev Returns sender allowlist configured via `targetSender` (empty means no sender allowlist).
    function targetSenders() public view returns (address[] memory targetedSenders_) {
        targetedSenders_ = _targetedSenders;
    }

    /// @dev Returns address-interface targets configured via `targetInterface`.
    function targetInterfaces() public view returns (FuzzInterface[] memory targetedInterfaces_) {
        targetedInterfaces_ = _targetedInterfaces;
    }
}
