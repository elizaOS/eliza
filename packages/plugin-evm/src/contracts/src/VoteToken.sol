// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ERC20 } from "node_modules/@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { ERC20Permit } from "node_modules/@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import { ERC20Votes } from "node_modules/@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import { Nonces } from "node_modules/@openzeppelin/contracts/utils/Nonces.sol";
import { Time } from "node_modules/@openzeppelin/contracts/utils/types/Time.sol";

contract VoteToken is ERC20Permit, ERC20Votes {
  constructor(
    string memory _name,
    string memory _symbol
  ) ERC20(_name, _symbol) ERC20Permit(_name) {}

  /**
   * Overrides
   */
  function _update(
    address from,
    address to,
    uint256 value
  ) internal override(ERC20, ERC20Votes) {
    super._update(from, to, value);
  }

  function nonces(
    address _owner
  ) public view override(ERC20Permit, Nonces) returns (uint256) {
    return super.nonces(_owner);
  }

  function decimals() public view virtual override(ERC20) returns (uint8) {
    return super.decimals();
  }

  /**
   * ERC5805 Clock
   */
  function clock() public view override returns (uint48) {
    return Time.timestamp();
  }

  function CLOCK_MODE() public pure override returns (string memory) {
    return "mode=timestamp";
  }
}
