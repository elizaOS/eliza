// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title MockOracle
/// @notice Mock optimistic oracle for testing dispute resolution
/// @dev Simulates proposal-dispute-resolution pattern for testing
contract MockOracle is Ownable {
    struct Assertion {
        address requester;
        bytes32 marketId;
        bytes32 assertedOutcome; // bytes32 to support any data type
        address proposer;
        uint256 bond;
        uint256 expirationTime;
        bool disputed;
        bool resolved;
        bytes32 resolvedOutcome;
    }

    mapping(bytes32 => Assertion) public assertions;

    uint256 public constant LIVENESS_PERIOD = 2 hours;
    uint256 public constant DISPUTE_BOND = 1 ether;

    event AssertionMade(
        bytes32 indexed assertionId,
        bytes32 indexed marketId,
        address indexed proposer,
        bytes32 assertedOutcome
    );
    event AssertionDisputed(bytes32 indexed assertionId, address indexed disputer);
    event AssertionResolved(bytes32 indexed assertionId, bytes32 resolvedOutcome);
    event AssertionSettled(bytes32 indexed assertionId, bytes32 outcome);

    constructor() Ownable(msg.sender) {}

    /// @notice Make an assertion about a market outcome
    /// @param _marketId Market identifier
    /// @param _assertedOutcome Proposed outcome
    /// @return assertionId The assertion identifier
    function assertTruth(
        bytes32 _marketId,
        bytes32 _assertedOutcome
    ) external payable returns (bytes32 assertionId) {
        require(msg.value >= DISPUTE_BOND, "Insufficient bond");

        assertionId = keccak256(abi.encodePacked(block.timestamp, msg.sender, _marketId));

        assertions[assertionId] = Assertion({
            requester: msg.sender,
            marketId: _marketId,
            assertedOutcome: _assertedOutcome,
            proposer: msg.sender,
            bond: msg.value,
            expirationTime: block.timestamp + LIVENESS_PERIOD,
            disputed: false,
            resolved: false,
            resolvedOutcome: bytes32(0)
        });

        emit AssertionMade(assertionId, _marketId, msg.sender, _assertedOutcome);
    }

    /// @notice Dispute an assertion
    /// @param _assertionId Assertion to dispute
    function disputeAssertion(bytes32 _assertionId) external payable {
        Assertion storage assertion = assertions[_assertionId];
        require(!assertion.resolved, "Already resolved");
        require(!assertion.disputed, "Already disputed");
        require(block.timestamp < assertion.expirationTime, "Liveness period expired");
        require(msg.value >= DISPUTE_BOND, "Insufficient dispute bond");

        assertion.disputed = true;

        emit AssertionDisputed(_assertionId, msg.sender);

        // In a real implementation, this would trigger voting
        // For mock purposes, owner will resolve disputes
    }

    /// @notice Settle assertion after liveness period (no disputes)
    /// @param _assertionId Assertion to settle
    function settleAssertion(bytes32 _assertionId) external {
        Assertion storage assertion = assertions[_assertionId];
        require(!assertion.resolved, "Already resolved");
        require(!assertion.disputed, "Disputed assertions must be resolved by owner");
        require(block.timestamp >= assertion.expirationTime, "Still in liveness period");

        assertion.resolved = true;
        assertion.resolvedOutcome = assertion.assertedOutcome;

        emit AssertionSettled(_assertionId, assertion.assertedOutcome);

        // Callback to requester (try first, then return bond)
        _callback(assertion.requester, assertion.marketId, assertion.assertedOutcome);

        // Return bond to proposer
        (bool success, ) = assertion.proposer.call{value: assertion.bond}("");
        require(success, "Bond return failed");
    }

    /// @notice Resolve disputed assertion (owner only)
    /// @param _assertionId Assertion to resolve
    /// @param _resolvedOutcome The resolved outcome
    function resolveDispute(
        bytes32 _assertionId,
        bytes32 _resolvedOutcome
    ) external onlyOwner {
        Assertion storage assertion = assertions[_assertionId];
        require(assertion.disputed, "Not disputed");
        require(!assertion.resolved, "Already resolved");

        assertion.resolved = true;
        assertion.resolvedOutcome = _resolvedOutcome;

        emit AssertionResolved(_assertionId, _resolvedOutcome);

        // Return bond to proposer if correct
        if (_resolvedOutcome == assertion.assertedOutcome) {
            (bool success, ) = assertion.proposer.call{value: assertion.bond}("");
            require(success, "Bond return failed");
        }

        // Callback to requester
        _callback(assertion.requester, assertion.marketId, _resolvedOutcome);
    }

    /// @notice Get assertion details
    function getAssertion(bytes32 _assertionId) external view returns (
        address requester,
        bytes32 marketId,
        bytes32 assertedOutcome,
        address proposer,
        uint256 expirationTime,
        bool disputed,
        bool resolved,
        bytes32 resolvedOutcome
    ) {
        Assertion storage assertion = assertions[_assertionId];
        return (
            assertion.requester,
            assertion.marketId,
            assertion.assertedOutcome,
            assertion.proposer,
            assertion.expirationTime,
            assertion.disputed,
            assertion.resolved,
            assertion.resolvedOutcome
        );
    }

    /// @notice Internal callback function
    function _callback(address _requester, bytes32 _marketId, bytes32 _outcome) internal {
        // Convert bytes32 outcome to uint8 for market resolution
        uint8 outcome = uint8(uint256(_outcome));

        // Try callback - intentionally ignore success for testing flexibility
        // This allows tests to work without requiring callback implementation
        // solhint-disable-next-line avoid-low-level-calls
        (bool success, ) = _requester.call(
            abi.encodeWithSignature(
                "mockOracleCallback(bytes32,uint8)",
                _marketId,
                outcome
            )
        );
        // Silence compiler warning - intentionally ignoring success
        // Mock contract should not revert if callback fails
        success;
    }

    /// @notice Withdraw accumulated bonds from invalid disputes (owner only)
    function withdraw() external onlyOwner {
        (bool success, ) = owner().call{value: address(this).balance}("");
        require(success, "Withdrawal failed");
    }

    receive() external payable {}
}

