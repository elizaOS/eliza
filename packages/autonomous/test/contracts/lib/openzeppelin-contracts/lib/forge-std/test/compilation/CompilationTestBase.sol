// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2 <0.9.0;

pragma experimental ABIEncoderV2;

import "../../src/Test.sol";

// The purpose of this contract is to benchmark compilation time to avoid accidentally introducing
// a change that results in very long compilation times with via-ir. See https://github.com/foundry-rs/forge-std/issues/207
contract CompilationTestBase is TestBase {}
