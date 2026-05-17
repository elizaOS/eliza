// SPDX-License-Identifier: AGPL-3.0
pragma solidity >=0.8.0 <0.9.0;

import {SVM} from "./SVM.sol";

abstract contract SymTest {
    // SVM cheat code address: 0xf3993a62377bcd56ae39d773740a5390411e8bc9
    address internal constant SVM_ADDRESS = address(uint160(uint256(keccak256("svm cheat code"))));

    SVM internal constant svm = SVM(SVM_ADDRESS);
}
