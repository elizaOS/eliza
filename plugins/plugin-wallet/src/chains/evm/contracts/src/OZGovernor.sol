// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "node_modules/@openzeppelin/contracts/governance/Governor.sol";
import "node_modules/@openzeppelin/contracts/governance/extensions/GovernorSettings.sol";
import "node_modules/@openzeppelin/contracts/governance/extensions/GovernorCountingSimple.sol";
import "node_modules/@openzeppelin/contracts/governance/extensions/GovernorVotes.sol";
import "node_modules/@openzeppelin/contracts/governance/extensions/GovernorVotesQuorumFraction.sol";
import "node_modules/@openzeppelin/contracts/governance/extensions/GovernorTimelockControl.sol";

contract OZGovernor is
  Governor,
  GovernorSettings,
  GovernorCountingSimple,
  GovernorVotes,
  GovernorVotesQuorumFraction,
  GovernorTimelockControl
{
  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor(
    IVotes _token,
    TimelockController _timelock,
    uint48 _votingDelay, // {s}
    uint32 _votingPeriod, // {s}
    uint256 _proposalThreshold, // e.g. 0.01e18 for 1%
    uint256 quorumPercent // e.g 4 for 4%
  )
    Governor("OZ Governor")
    GovernorSettings(_votingDelay, _votingPeriod, _proposalThreshold)
    GovernorVotes(_token)
    GovernorVotesQuorumFraction(quorumPercent)
    GovernorTimelockControl(_timelock)
  {}

  function votingDelay()
    public
    view
    override(Governor, GovernorSettings)
    returns (uint256)
  {
    return super.votingDelay();
  }

  function votingPeriod()
    public
    view
    override(Governor, GovernorSettings)
    returns (uint256)
  {
    return super.votingPeriod();
  }

  function quorum(
    uint256 blockNumber
  )
    public
    view
    override(Governor, GovernorVotesQuorumFraction)
    returns (uint256)
  {
    return super.quorum(blockNumber);
  }

  function state(
    uint256 proposalId
  )
    public
    view
    override(Governor, GovernorTimelockControl)
    returns (ProposalState)
  {
    return super.state(proposalId);
  }

  function proposalNeedsQueuing(
    uint256 proposalId
  ) public view override(Governor, GovernorTimelockControl) returns (bool) {
    return super.proposalNeedsQueuing(proposalId);
  }

  function proposalThreshold()
    public
    view
    override(Governor, GovernorSettings)
    returns (uint256)
  {
    uint256 threshold = super.proposalThreshold(); // D18{1}
    uint256 pastSupply = token().getPastTotalSupply(clock() - 1);

    // CEIL to make sure thresholds near 0% don't get rounded down to 0 tokens
    return (threshold * pastSupply + (1e18 - 1)) / 1e18;
  }

  function _queueOperations(
    uint256 proposalId,
    address[] memory targets,
    uint256[] memory values,
    bytes[] memory calldatas,
    bytes32 descriptionHash
  ) internal override(Governor, GovernorTimelockControl) returns (uint48) {
    return
      super._queueOperations(
        proposalId,
        targets,
        values,
        calldatas,
        descriptionHash
      );
  }

  function _executeOperations(
    uint256 proposalId,
    address[] memory targets,
    uint256[] memory values,
    bytes[] memory calldatas,
    bytes32 descriptionHash
  ) internal override(Governor, GovernorTimelockControl) {
    super._executeOperations(
      proposalId,
      targets,
      values,
      calldatas,
      descriptionHash
    );
  }

  function _cancel(
    address[] memory targets,
    uint256[] memory values,
    bytes[] memory calldatas,
    bytes32 descriptionHash
  ) internal override(Governor, GovernorTimelockControl) returns (uint256) {
    return super._cancel(targets, values, calldatas, descriptionHash);
  }

  function _executor()
    internal
    view
    override(Governor, GovernorTimelockControl)
    returns (address)
  {
    return super._executor();
  }
}
